//! A process tree has one non-cancellable owner. Cancelling a waiter never
//! cancels OS reaping or releases ownership of descendants.
use std::{io, process::ExitStatus};
use tokio::{
    process::{ChildStdin, ChildStdout, Command},
    sync::watch,
};

type Outcome = Result<ExitStatus, (io::ErrorKind, String)>;

#[derive(Default)]
struct Owners {
    runtime: Option<tokio::runtime::Handle>,
    closing: bool,
    next_id: u64,
    active: std::collections::HashMap<u64, watch::Sender<bool>>,
    failure: Option<(io::ErrorKind, String)>,
}

struct Registry {
    owners: std::sync::Mutex<Owners>,
    count: watch::Sender<usize>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            owners: Default::default(),
            count: watch::channel(0).0,
        }
    }
}

impl Registry {
    fn set_owner_runtime(&self, runtime: tokio::runtime::Handle) -> io::Result<()> {
        let mut owners = self.owners.lock().expect("process registry lock");
        if owners.runtime.is_some() || owners.next_id != 0 || owners.closing {
            return Err(io::Error::other("process owner runtime is already in use"));
        }
        owners.runtime = Some(runtime);
        Ok(())
    }

    async fn shutdown(&self) -> io::Result<()> {
        let mut count = self.count.subscribe();
        {
            let mut owners = self.owners.lock().expect("process registry lock");
            owners.closing = true;
            for stop in owners.active.values() {
                let _ = stop.send(true);
            }
        }
        while *count.borrow_and_update() != 0 {
            count
                .changed()
                .await
                .map_err(|_| io::Error::other("process registry closed"))?;
        }
        match &self.owners.lock().expect("process registry lock").failure {
            Some((kind, message)) => Err(io::Error::new(*kind, message.clone())),
            None => Ok(()),
        }
    }
}

fn registry() -> std::sync::Arc<Registry> {
    static REGISTRY: std::sync::OnceLock<std::sync::Arc<Registry>> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(Default::default).clone()
}

/// Permanently close process admission and wait for all owners, including those
/// whose public Child was dropped. Call before shutting down the Tokio runtime.
pub async fn shutdown() -> io::Result<()> {
    registry().shutdown().await
}

/// Configure a separate owner runtime before the first process is spawned.
/// Keep it alive through shutdown(), even after the application runtime stops.
/// Without this configuration, owners use the caller's runtime as before.
pub fn set_owner_runtime(runtime: tokio::runtime::Handle) -> io::Result<()> {
    registry().set_owner_runtime(runtime)
}

struct Registration {
    registry: std::sync::Arc<Registry>,
    id: u64,
    failure: Option<(io::ErrorKind, String)>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut owners = self.registry.owners.lock().expect("process registry lock");
        owners.active.remove(&self.id);
        if owners.failure.is_none() {
            owners.failure = self.failure.take();
        }
        self.registry.count.send_replace(owners.active.len());
    }
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// Capture bounded stdout. Explicit failures wait for the entire tree to exit;
/// cancelling this future instead requests cleanup from the independent owner.
/// Stderr is discarded so credentials and unbounded diagnostics are not retained.
pub async fn capture(
    mut command: Command,
    deadline: std::time::Duration,
    max_bytes: usize,
) -> io::Result<(ExitStatus, Vec<u8>)> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = spawn(command)?;
    let result = tokio::time::timeout(deadline, async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .expect("piped stdout")
            .take((max_bytes as u64).saturating_add(1))
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process output exceeds limit",
            ));
        }
        Ok((child.wait().await?, bytes))
    })
    .await
    .unwrap_or_else(|_| {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process capture timed out",
        ))
    });
    if result.is_err() {
        child.kill().await?;
    }
    result
}

pub struct Child {
    stop: watch::Sender<bool>,
    status: watch::Receiver<Option<Outcome>>,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
}

impl Child {
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            self.status
                .changed()
                .await
                .map_err(|_| io::Error::other("process owner stopped without reaping"))?;
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match &*self.status.borrow() {
            None => Ok(None),
            Some(Ok(status)) => Ok(Some(*status)),
            Some(Err((kind, message))) => Err(io::Error::new(*kind, message.clone())),
        }
    }

    pub async fn kill(&mut self) -> io::Result<()> {
        let _ = self.stop.send(true);
        self.wait().await.map(|_| ())
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

/// A resource-level drain boundary, independent of cancellation of its waiter.
/// Spawned subtasks must explicitly enter the same scope; task locals are not
/// inherited by tokio::spawn. The global process registry still owns all trees.
#[derive(Clone, Default)]
pub struct Scope(std::sync::Arc<std::sync::Mutex<ScopeState>>);

#[derive(Default)]
struct ScopeState {
    closing: bool,
    children: Vec<(watch::Sender<bool>, watch::Receiver<Option<Outcome>>)>,
    blocking: Vec<watch::Receiver<bool>>,
}

tokio::task_local! { static PROCESS_SCOPE: Scope; }

impl Scope {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run<F: std::future::Future>(&self, work: F) -> F::Output {
        PROCESS_SCOPE.scope(self.clone(), work).await
    }

    /// A positive result proves every process tree admitted to this scope was
    /// reaped. It does not infer exit from a lease, PID or abandoned waiter.
    pub async fn shutdown(&self) -> io::Result<()> {
        let (children, blocking) = {
            let mut scope = self.0.lock().expect("process scope lock");
            scope.closing = true;
            for (stop, _) in &scope.children {
                let _ = stop.send(true);
            }
            (scope.children.clone(), scope.blocking.clone())
        };
        for mut completed in blocking {
            while !*completed.borrow_and_update() {
                completed.changed().await.map_err(|_| {
                    io::Error::other("blocking operation owner stopped without receipt")
                })?;
            }
        }
        for (_, mut result) in children {
            loop {
                let outcome = result.borrow_and_update().clone();
                if let Some(outcome) = outcome {
                    outcome.map_err(|(kind, text)| io::Error::new(kind, text))?;
                    break;
                }
                result
                    .changed()
                    .await
                    .map_err(|_| io::Error::other("process owner stopped without reaping"))?;
            }
        }
        Ok(())
    }
}

/// Execute non-interruptible file work under the current resource scope.
/// Cancelling the waiter does not detach disposal evidence: shutdown waits for
/// the operation, including disposal of an undelivered return value. The caller
/// must drop any successfully returned resource before acknowledging its scope.
pub async fn blocking<F, T>(work: F) -> io::Result<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    struct Completed(watch::Sender<bool>);
    impl Drop for Completed {
        fn drop(&mut self) {
            self.0.send_replace(true);
        }
    }
    let scope = PROCESS_SCOPE.try_with(Clone::clone).ok();
    let (complete, completed) = watch::channel(false);
    let (send, receive) = tokio::sync::oneshot::channel();
    let owner = Completed(complete);
    // Registration is synchronous with admission. No blocking task exists
    // outside the ledger, even if its caller is cancelled immediately.
    if let Some(scope) = &scope {
        let mut state = scope.0.lock().expect("process scope lock");
        if state.closing {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "process scope is closing",
            ));
        }
        state.blocking.retain(|receipt| !*receipt.borrow());
        state.blocking.push(completed);
        tokio::task::spawn_blocking(move || {
            let _owner = owner;
            // Failed delivery drops T before _owner records completion.
            let _ = send.send(work());
        });
    } else {
        tokio::task::spawn_blocking(move || {
            let _owner = owner;
            let _ = send.send(work());
        });
    }
    receive
        .await
        .map_err(|_| io::Error::other("blocking operation failed"))
}

pub fn spawn(command: Command) -> io::Result<Child> {
    if let Ok(scope) = PROCESS_SCOPE.try_with(Clone::clone) {
        // Admission and shutdown serialize, including clones used concurrently.
        let mut state = scope.0.lock().expect("process scope lock");
        if state.closing {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "process scope is closing",
            ));
        }
        let child = spawn_registered(command, registry())?;
        state
            .children
            .push((child.stop.clone(), child.status.clone()));
        Ok(child)
    } else {
        spawn_registered(command, registry())
    }
}

fn spawn_registered(mut command: Command, registry: std::sync::Arc<Registry>) -> io::Result<Child> {
    // Admission and registration share one lock with shutdown: there is no
    // successfully spawned but unregistered child across the closing boundary.
    let mut owners = registry.owners.lock().expect("process registry lock");
    if owners.closing {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "media processes are shutting down",
        ));
    }
    let runtime = owners
        .runtime
        .clone()
        .unwrap_or_else(tokio::runtime::Handle::current);
    // Register process and pipe IO with the owner's reactor too. Moving only
    // the reaping task would leave its process driver on the cancelled runtime.
    let _entered = runtime.enter();
    command.kill_on_drop(true);
    let mut child = platform::spawn(command)?;
    let stdin = platform::stdin(&mut child);
    let stdout = platform::stdout(&mut child);
    let (stop, receiver) = watch::channel(false);
    let (status, result) = watch::channel(None);
    let id = owners.next_id;
    owners.next_id += 1;
    owners.active.insert(id, stop.clone());
    registry.count.send_replace(owners.active.len());
    drop(owners);
    let mut registration = Registration {
        registry,
        id,
        failure: Some((
            io::ErrorKind::Other,
            "process owner stopped before reaping".into(),
        )),
    };
    runtime.spawn(async move {
        let outcome = platform::reap(child, receiver)
            .await
            .map_err(|e| (e.kind(), e.to_string()));
        registration.failure = outcome.as_ref().err().cloned();
        let _ = status.send(Some(outcome));
        drop(registration);
    });
    Ok(Child {
        stop,
        status: result,
        stdin,
        stdout,
    })
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::time::Duration;

    pub struct Tree {
        child: tokio::process::Child,
        pgid: libc::pid_t,
        signalled: bool,
    }

    impl Tree {
        fn terminate(&mut self) -> io::Result<()> {
            if !self.signalled {
                // The leader has not been reaped, so its PID/PGID cannot have
                // been reused for an unrelated process group.
                if unsafe { libc::kill(-self.pgid, libc::SIGKILL) } != 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::ESRCH) {
                        return Err(error);
                    }
                }
                self.signalled = true;
            }
            Ok(())
        }

        fn leader_exited(&mut self) -> io::Result<bool> {
            // Observe without reaping. Do not use Tokio wait/try_wait before
            // signalling the group, including a normally exited leader.
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pgid as libc::id_t,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    return Ok(false);
                }
                if error.raw_os_error() == Some(libc::ECHILD) {
                    // Ownership was lost outside this actor. Never signal a
                    // numeric group whose leader might already have been reused.
                    self.signalled = true;
                }
                return Err(error);
            }
            Ok(unsafe { info.assume_init().si_pid() } != 0)
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = self.terminate();
        }
    }

    pub fn spawn(mut command: Command) -> io::Result<Tree> {
        #[cfg(target_os = "linux")]
        // Adopt orphaned grandchildren, including native execution without an
        // init wrapper. Each owner reaps only its own process group.
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        command.process_group(0);
        let child = command.spawn()?;
        let pgid = child.id().expect("new child has pid") as libc::pid_t;
        Ok(Tree {
            child,
            pgid,
            signalled: false,
        })
    }

    pub fn stdin(tree: &mut Tree) -> Option<ChildStdin> {
        tree.child.stdin.take()
    }
    pub fn stdout(tree: &mut Tree) -> Option<ChildStdout> {
        tree.child.stdout.take()
    }

    pub async fn reap(mut tree: Tree, mut stop: watch::Receiver<bool>) -> io::Result<ExitStatus> {
        loop {
            if tree.leader_exited()? {
                break;
            }
            tokio::select! {
                _ = stopped(&mut stop) => break,
                _ = tokio::time::sleep(Duration::from_millis(20)) => {},
            }
        }
        tree.terminate()?;
        let status = tree.child.wait().await?;
        loop {
            // Linux subreaper adoption can happen after the leader was reaped.
            // Never signal this numeric PGID again after reaping the leader.
            let mut raw = 0;
            loop {
                let waited = unsafe { libc::waitpid(-tree.pgid, &mut raw, libc::WNOHANG) };
                if waited > 0 {
                    continue;
                }
                if waited < 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(libc::EINTR) {
                        continue;
                    }
                    if error.raw_os_error() != Some(libc::ECHILD) {
                        return Err(error);
                    }
                }
                break;
            }
            if unsafe { libc::kill(-tree.pgid, 0) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(status);
                }
                return Err(error);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        time::Duration,
    };
    use windows::Win32::{
        Foundation::HANDLE,
        System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*},
    };

    pub struct Tree {
        child: tokio::process::Child,
        job: OwnedHandle,
    }

    fn owned(handle: HANDLE) -> OwnedHandle {
        // Every caller transfers a newly created, valid owned kernel handle.
        unsafe { OwnedHandle::from_raw_handle(handle.0) }
    }

    fn resume(pid: u32) -> io::Result<()> {
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }?);
        let handle = HANDLE(snapshot.as_raw_handle());
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        unsafe { Thread32First(handle, &mut entry) }?;
        loop {
            if entry.th32OwnerProcessID == pid {
                let thread =
                    owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }?);
                if unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            if unsafe { Thread32Next(handle, &mut entry) }.is_err() {
                break;
            }
        }
        Err(io::Error::other("suspended process has no primary thread"))
    }

    pub fn spawn(mut command: Command) -> io::Result<Tree> {
        let job = owned(unsafe { CreateJobObjectW(None, None) }?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                HANDLE(job.as_raw_handle()),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        }?;
        // Assignment happens before user code can fork. No breakaway flags.
        command.creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0);
        let mut child = command.spawn()?;
        let assigned = unsafe {
            AssignProcessToJobObject(
                HANDLE(job.as_raw_handle()),
                HANDLE(child.raw_handle().expect("new process handle")),
            )
        };
        if let Err(error) = assigned {
            let _ = child.start_kill();
            return Err(error.into());
        }
        if let Err(error) = resume(child.id().expect("new process pid")) {
            let _ = child.start_kill();
            return Err(error);
        }
        Ok(Tree { child, job })
    }

    pub fn stdin(tree: &mut Tree) -> Option<ChildStdin> {
        tree.child.stdin.take()
    }
    pub fn stdout(tree: &mut Tree) -> Option<ChildStdout> {
        tree.child.stdout.take()
    }

    fn process_handles(job: HANDLE) -> io::Result<Vec<OwnedHandle>> {
        use windows::Win32::Foundation::{ERROR_INVALID_PARAMETER, ERROR_MORE_DATA};
        let mut words = 66;
        loop {
            let mut buffer = vec![0usize; words];
            let list = buffer
                .as_mut_ptr()
                .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            let result = unsafe {
                QueryInformationJobObject(
                    Some(job),
                    JobObjectBasicProcessIdList,
                    list.cast(),
                    (buffer.len() * std::mem::size_of::<usize>()) as u32,
                    None,
                )
            };
            match result {
                Err(error) if error.code() == ERROR_MORE_DATA.to_hresult() && words < 262144 => {
                    words *= 2;
                    continue;
                }
                Err(error) => return Err(error.into()),
                Ok(()) => {}
            }
            let count = unsafe { (*list).NumberOfProcessIdsInList } as usize;
            if count > words - 2 {
                return Err(io::Error::other("job process list exceeds buffer"));
            }
            let ids = unsafe { std::slice::from_raw_parts((*list).ProcessIdList.as_ptr(), count) };
            let mut handles = Vec::with_capacity(count);
            for id in ids {
                match unsafe {
                    OpenProcess(
                        PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        *id as u32,
                    )
                } {
                    Ok(handle) => {
                        let handle = owned(handle);
                        let mut member = Default::default();
                        unsafe {
                            IsProcessInJob(HANDLE(handle.as_raw_handle()), Some(job), &mut member)
                        }?;
                        if member.as_bool() {
                            handles.push(handle);
                        }
                    }
                    Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => {}
                    Err(error) => return Err(error.into()),
                }
            }
            return Ok(handles);
        }
    }

    pub async fn reap(mut tree: Tree, mut stop: watch::Receiver<bool>) -> io::Result<ExitStatus> {
        // Wait only for the leader here. Then kill remaining descendants even
        // when it exited successfully, before waiting for the whole job.
        tokio::select! {
            _ = stopped(&mut stop) => {},
            result = tree.child.wait() => { result?; },
        }
        let mut handles = process_handles(HANDLE(tree.job.as_raw_handle()))?;
        unsafe { TerminateJobObject(HANDLE(tree.job.as_raw_handle()), 1) }?;
        handles.extend(process_handles(HANDLE(tree.job.as_raw_handle()))?);
        let status = tree.child.wait().await?;
        loop {
            use windows::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0};
            let mut exited = true;
            for handle in &handles {
                let result = unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), 0) };
                if result == WAIT_FAILED {
                    return Err(io::Error::last_os_error());
                }
                exited &= result == WAIT_OBJECT_0;
            }
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(HANDLE(tree.job.as_raw_handle())),
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut _,
                    std::mem::size_of_val(&accounting) as u32,
                    None,
                )
            }?;
            if accounting.ActiveProcesses == 0 && exited {
                return Ok(status);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, process::Stdio, time::Duration};

    #[test]
    #[ignore = "process tree fixture launched by lifecycle tests"]
    #[allow(clippy::zombie_processes)] // Deliberately orphan a leaf to test production reaping.
    fn tree_fixture() {
        let root = PathBuf::from(std::env::var_os("RAINSYNC_TREE_FIXTURE").unwrap());
        if std::env::var_os("RAINSYNC_TREE_LEAF").is_some() {
            std::fs::write(root.join("leaf.pid.tmp"), std::process::id().to_string()).unwrap();
            std::fs::rename(root.join("leaf.pid.tmp"), root.join("leaf.pid")).unwrap();
            std::thread::sleep(Duration::from_secs(120));
            return;
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "child_process::tests::tree_fixture"])
            .env("RAINSYNC_TREE_LEAF", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut leaf = command.spawn().unwrap();
        for _ in 0..6000 {
            if root.join("output").exists() {
                use std::io::Write;
                std::io::stdout().write_all(&[b'x'; 512]).unwrap();
                std::io::stdout().flush().unwrap();
                std::fs::remove_file(root.join("output")).unwrap();
            }
            if root.join("exit").exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = leaf.kill();
        let _ = leaf.wait();
    }

    #[cfg(windows)]
    struct Witness(windows::Win32::Foundation::HANDLE);
    #[cfg(windows)]
    impl Witness {
        fn open(pid: u32) -> Self {
            use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            Self(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.unwrap())
        }
        fn exited(&self) -> bool {
            use windows::Win32::{
                Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject,
            };
            unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
        }
    }
    #[cfg(windows)]
    impl Drop for Witness {
        fn drop(&mut self) {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
        }
    }
    #[cfg(unix)]
    struct Witness(libc::pid_t);
    #[cfg(unix)]
    impl Witness {
        fn open(pid: u32) -> Self {
            Self(pid as libc::pid_t)
        }
        fn exited(&self) -> bool {
            (unsafe { libc::kill(self.0, 0) }) != 0
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }

    #[tokio::test]
    async fn scope_receipt_survives_cancelled_waiter_and_closes_admission() {
        let root = std::env::temp_dir().join(format!("rainsync-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let scope = Scope::new();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "child_process::tests::tree_fixture"])
            .env("RAINSYNC_TREE_FIXTURE", &root)
            .env_remove("RAINSYNC_TREE_LEAF")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = scope.run(async { spawn(command).unwrap() }).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !root.join("leaf.pid").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let witness = Witness::open(
            std::fs::read_to_string(root.join("leaf.pid"))
                .unwrap()
                .parse()
                .unwrap(),
        );
        assert!(!witness.exited());
        drop(child); // Public cancellation only requests stop; no false receipt.
        tokio::time::timeout(Duration::from_secs(5), scope.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(witness.exited());
        scope.shutdown().await.unwrap(); // Idempotent, positive receipt survives.
        assert_eq!(
            scope
                .run(async { spawn(Command::new("never-spawned")) })
                .await
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::Interrupted
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn scope_waits_for_cancelled_blocking_io_and_disposes_late_result() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        struct Resource(Arc<AtomicBool>);
        impl Drop for Resource {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let disposed = Arc::new(AtomicBool::new(false));
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let scope = Scope::new();
        let task_scope = scope.clone();
        let witness = disposed.clone();
        let waiter = tokio::spawn(async move {
            task_scope
                .run(blocking(move || {
                    entered.send(()).unwrap();
                    blocked.recv().unwrap();
                    Resource(witness)
                }))
                .await
        });
        ready.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), scope.shutdown())
                .await
                .is_err()
        );
        assert!(!disposed.load(Ordering::SeqCst));
        release.send(()).unwrap();
        scope.shutdown().await.unwrap();
        assert!(disposed.load(Ordering::SeqCst));
        assert_eq!(
            scope.run(blocking(|| 1)).await.unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
    }

    #[test]
    fn owner_reaps_after_application_runtime_is_destroyed() {
        let owners = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let application = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let registry = std::sync::Arc::new(Registry::default());
        registry.set_owner_runtime(owners.handle().clone()).unwrap();
        let root = std::env::temp_dir().join(format!("rainsync-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let witness = application.block_on(async {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--ignored", "--exact", "child_process::tests::tree_fixture"])
                .env("RAINSYNC_TREE_FIXTURE", &root)
                .env_remove("RAINSYNC_TREE_LEAF")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = spawn_registered(command, registry.clone()).unwrap();
            tokio::spawn(async move { child.wait().await });
            tokio::time::timeout(Duration::from_secs(5), async {
                while !root.join("leaf.pid").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            Witness::open(
                std::fs::read_to_string(root.join("leaf.pid"))
                    .unwrap()
                    .parse()
                    .unwrap(),
            )
        });
        assert!(!witness.exited());
        drop(application);
        owners.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), registry.shutdown())
                .await
                .unwrap()
                .unwrap();
        });
        assert!(witness.exited());
        assert!(registry.owners.lock().unwrap().active.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn shutdown_reaps_owned_and_dropped_children_and_closes_admission() {
        let registry = std::sync::Arc::new(Registry::default());
        let mut children = Vec::new();
        let mut witnesses = Vec::new();
        let mut roots = Vec::new();
        for _ in 0..2 {
            let root =
                std::env::temp_dir().join(format!("rainsync-drain-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--ignored", "--exact", "child_process::tests::tree_fixture"])
                .env("RAINSYNC_TREE_FIXTURE", &root)
                .env_remove("RAINSYNC_TREE_LEAF")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            children.push(spawn_registered(command, registry.clone()).unwrap());
            tokio::time::timeout(Duration::from_secs(5), async {
                while !root.join("leaf.pid").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            witnesses.push(Witness::open(
                std::fs::read_to_string(root.join("leaf.pid"))
                    .unwrap()
                    .parse()
                    .unwrap(),
            ));
            roots.push(root);
        }
        drop(children.pop());
        // Interrupting a shutdown waiter cannot reopen admission or discard owners.
        let mut shutdown = Box::pin(registry.shutdown());
        std::future::poll_fn(|context| {
            assert!(std::future::Future::poll(shutdown.as_mut(), context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        drop(shutdown);
        let error = spawn_registered(Command::new("must-never-be-launched"), registry.clone())
            .err()
            .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        tokio::time::timeout(Duration::from_secs(5), registry.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(witnesses.iter().all(Witness::exited));
        assert!(children[0].try_wait().unwrap().is_some());
        assert!(registry.owners.lock().unwrap().active.is_empty());
        registry.shutdown().await.unwrap();
        for root in roots {
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn capture_reaps_on_deadline_limit_success_and_cancellation() {
        for mode in ["deadline", "limit", "success", "cancel"] {
            let root =
                std::env::temp_dir().join(format!("rainsync-capture-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--ignored",
                    "--exact",
                    "child_process::tests::tree_fixture",
                    "--nocapture",
                ])
                .env("RAINSYNC_TREE_FIXTURE", &root)
                .env_remove("RAINSYNC_TREE_LEAF");
            let task = tokio::spawn(capture(
                command,
                Duration::from_secs(3),
                if mode == "limit" { 256 } else { 4096 },
            ));
            tokio::time::timeout(Duration::from_secs(2), async {
                while !root.join("leaf.pid").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let witness = Witness::open(
                std::fs::read_to_string(root.join("leaf.pid"))
                    .unwrap()
                    .parse()
                    .unwrap(),
            );
            assert!(!witness.exited());
            match mode {
                "limit" => {
                    std::fs::write(root.join("output"), b"emit beyond the capture limit").unwrap()
                }
                "success" => {
                    std::fs::write(root.join("exit"), b"leave a descendant running").unwrap()
                }
                "cancel" => task.abort(),
                _ => {}
            }
            let result = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap();
            if mode == "cancel" {
                assert!(result.unwrap_err().is_cancelled());
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !witness.exited() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
            } else {
                let result = result.unwrap();
                match mode {
                    "deadline" => assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut),
                    "limit" => assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData),
                    "success" => assert!(result.unwrap().0.success()),
                    _ => unreachable!(),
                }
                assert!(witness.exited(), "capture must reap before returning");
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn descendants_exit_on_kill_drop_normal_exit_and_cancelled_wait() {
        for mode in ["kill", "drop", "normal", "cancelled_wait"] {
            let root = std::env::temp_dir().join(format!("rainsync-tree-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--ignored", "--exact", "child_process::tests::tree_fixture"])
                .env("RAINSYNC_TREE_FIXTURE", &root)
                .env_remove("RAINSYNC_TREE_LEAF")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = spawn(command).unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !root.join("leaf.pid").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let pid = std::fs::read_to_string(root.join("leaf.pid"))
                .unwrap()
                .parse()
                .unwrap();
            let witness = Witness::open(pid);
            assert!(!witness.exited());
            match mode {
                "normal" => {
                    std::fs::write(root.join("exit"), b"exit parent only").unwrap();
                    assert!(
                        tokio::time::timeout(Duration::from_secs(5), child.wait())
                            .await
                            .unwrap()
                            .unwrap()
                            .success()
                    );
                    assert!(witness.exited(), "successful wait includes descendants");
                }
                "drop" => {
                    drop(child);
                }
                _ => {
                    if mode == "cancelled_wait" {
                        assert!(
                            tokio::time::timeout(Duration::from_millis(5), child.wait())
                                .await
                                .is_err()
                        );
                        assert!(!witness.exited());
                    }
                    tokio::time::timeout(Duration::from_secs(5), child.kill())
                        .await
                        .unwrap()
                        .unwrap();
                    assert!(child.try_wait().unwrap().is_some());
                    assert!(witness.exited(), "kill waits for descendants");
                }
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                while !witness.exited() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            std::fs::remove_dir_all(&root).unwrap();
        }
    }
}
