//! A process tree has one non-cancellable owner. Cancelling a waiter never
//! cancels OS reaping or releases ownership of descendants.
use std::{io, process::ExitStatus};
use tokio::{
    process::{ChildStdin, ChildStdout, Command},
    sync::watch,
};

type Outcome = Result<ExitStatus, (io::ErrorKind, String)>;

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

pub fn spawn(mut command: Command) -> io::Result<Child> {
    command.kill_on_drop(true);
    let mut child = platform::spawn(command)?;
    let stdin = platform::stdin(&mut child);
    let stdout = platform::stdout(&mut child);
    let (stop, receiver) = watch::channel(false);
    let (status, result) = watch::channel(None);
    tokio::spawn(async move {
        let outcome = platform::reap(child, receiver)
            .await
            .map_err(|e| (e.kind(), e.to_string()));
        let _ = status.send(Some(outcome));
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
                _ = crate::process::stopped(&mut stop) => break,
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
            _ = crate::process::stopped(&mut stop) => {},
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
