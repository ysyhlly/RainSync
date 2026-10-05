//! Interactive, first-account-only bootstrap. Passwords never enter argv or logs.
use super::*;
use std::io::{Read, Write};
use zeroize::Zeroizing;

fn username(arguments: &[String]) -> anyhow::Result<&str> {
    anyhow::ensure!(
        arguments.len() == 2 && arguments[0] == "--username",
        "usage: rainsync-server init-admin --username NAME"
    );
    anyhow::ensure!(
        account_rules::valid_username(&arguments[1]),
        "invalid administrator username"
    );
    Ok(&arguments[1])
}

/// The one allocation is bounded and wiped, including rejected input. Invalid or
/// oversized input is consumed through the newline while terminal echo is hidden.
struct PasswordLine {
    text: Zeroizing<String>,
    too_long: bool,
    invalid: bool,
}
impl PasswordLine {
    fn new() -> Self {
        Self {
            text: Zeroizing::new(String::with_capacity(1025)),
            too_long: false,
            invalid: false,
        }
    }
    fn push(&mut self, byte: u8) -> anyhow::Result<bool> {
        if byte == b'\n' {
            if self.text.ends_with('\r') {
                self.text.pop();
            }
            anyhow::ensure!(
                !self.too_long && self.text.len() <= 1024,
                "password is too long"
            );
            anyhow::ensure!(
                !self.invalid && account_rules::valid_password(&self.text),
                "password must have 8-1024 printable ASCII characters; spaces are preserved"
            );
            return Ok(true);
        }
        if !(0x20..=0x7e).contains(&byte) && byte != b'\r' {
            self.invalid = true;
        } else if self.text.len() < 1025 {
            self.text.push(char::from(byte));
        } else {
            self.too_long = true;
        }
        Ok(false)
    }
}

#[cfg(test)]
fn password_line(input: &mut impl Read) -> anyhow::Result<Zeroizing<String>> {
    let mut line = PasswordLine::new();
    let mut byte = Zeroizing::new([0u8]);
    loop {
        anyhow::ensure!(input.read(&mut *byte)? == 1, "password input interrupted");
        if line.push(byte[0])? {
            return Ok(line.text);
        }
    }
}

#[cfg(unix)]
struct Terminal {
    input: tokio::io::unix::AsyncFd<std::fs::File>,
    original: libc::termios,
    flags: libc::c_int,
}
#[cfg(unix)]
impl Terminal {
    fn hide() -> anyhow::Result<Self> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // A duplicate owns its lifetime; its shared file-status flags are restored
        // together with terminal settings before the duplicate is closed.
        let fd = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_DUPFD_CLOEXEC, 3) };
        anyhow::ensure!(fd >= 0, "cannot open password terminal");
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let mut original = std::mem::MaybeUninit::<libc::termios>::uninit();
        anyhow::ensure!(
            unsafe { libc::tcgetattr(file.as_raw_fd(), original.as_mut_ptr()) } == 0,
            "cannot read terminal settings"
        );
        let original = unsafe { original.assume_init() };
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        anyhow::ensure!(flags >= 0, "cannot read password terminal flags");
        // Register readiness before changing any terminal state.
        let terminal = Self {
            input: tokio::io::unix::AsyncFd::new(file)?,
            original,
            flags,
        };
        anyhow::ensure!(
            unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0,
            "cannot prepare password terminal"
        );
        let mut hidden = original;
        hidden.c_lflag &= !(libc::ECHO | libc::ECHONL);
        // Canonical editing and normal Ctrl-C/Ctrl-D behavior are retained.
        anyhow::ensure!(
            unsafe { libc::tcsetattr(fd, libc::TCSANOW, &hidden) } == 0,
            "cannot hide password input"
        );
        Ok(terminal)
    }

    async fn password(&self, interrupts: &mut Interrupts) -> anyhow::Result<Zeroizing<String>> {
        let mut line = PasswordLine::new();
        let mut byte = Zeroizing::new([0u8]);
        loop {
            let mut ready = tokio::select! {
                biased;
                _ = interrupts.received() => anyhow::bail!("password input interrupted"),
                ready = self.input.readable() => ready?,
            };
            match ready.try_io(|inner| {
                let mut input = inner.get_ref();
                input.read(&mut *byte)
            }) {
                Ok(Ok(1)) => {
                    if line.push(byte[0])? {
                        return Ok(line.text);
                    }
                }
                Ok(Ok(_)) => anyhow::bail!("password input interrupted"),
                Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => continue,
            }
        }
    }
}
#[cfg(unix)]
impl Drop for Terminal {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        let fd = self.input.get_ref().as_raw_fd();
        // TCSAFLUSH discards any remaining password input on a rejected attempt.
        let settings = unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &self.original) };
        let flags = unsafe { libc::fcntl(fd, libc::F_SETFL, self.flags) };
        eprintln!();
        if settings != 0 || flags != 0 {
            eprintln!(
                "Warning: could not restore terminal settings; run stty sane in your terminal."
            );
        }
    }
}

#[cfg(unix)]
struct Interrupts {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
    quit: tokio::signal::unix::Signal,
}
#[cfg(unix)]
impl Interrupts {
    fn new() -> anyhow::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        // Establish handlers before echo is hidden so these signals unwind the
        // guard. SIGKILL and loss of the terminal cannot be recovered by a process.
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
            quit: signal(SignalKind::quit())?,
        })
    }
    async fn received(&mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {},
            _ = self.terminate.recv() => {},
            _ = self.hangup.recv() => {},
            _ = self.quit.recv() => {},
        }
    }
}

pub(crate) async fn run(arguments: &[String]) -> anyhow::Result<()> {
    use std::io::IsTerminal;
    let name = username(arguments)?;
    anyhow::ensure!(
        std::io::stdin().is_terminal() && std::io::stderr().is_terminal(),
        "administrator initialization requires an interactive terminal; redirected passwords are refused"
    );
    #[cfg(not(unix))]
    anyhow::bail!("run initialization in the Linux deployment container's interactive terminal");
    #[cfg(unix)]
    {
        let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
        persistence::migrate(&db).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
            .fetch_one(&db)
            .await?;
        anyhow::ensure!(
            count == 0,
            "accounts already exist; this command never replaces or resets them"
        );
        let password = {
            let mut interrupts = Interrupts::new()?;
            let terminal = Terminal::hide()?;
            eprint!("Administrator password: ");
            std::io::stderr().flush()?;
            let password = terminal.password(&mut interrupts).await?;
            eprint!("\nConfirm password: ");
            std::io::stderr().flush()?;
            let confirmation = terminal.password(&mut interrupts).await?;
            anyhow::ensure!(*password == *confirmation, "passwords do not match");
            password
        };
        let password_hash = Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map_err(|_| anyhow::anyhow!("password hashing failed"))?
            .to_string();
        drop(password);
        let mut tx = db.begin().await?;
        sqlx::query("SET LOCAL lock_timeout='5s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL statement_timeout='10s'")
            .execute(&mut *tx)
            .await?;
        // Conflicts with other bootstrap locks and ordinary INSERT/UPDATE/DELETE.
        // The in-transaction recheck ensures this can never reset any account.
        sqlx::query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
            .fetch_one(&mut *tx)
            .await?;
        anyhow::ensure!(
            count == 0,
            "another account was created; no account changed"
        );
        sqlx::query("INSERT INTO users(id,username,password_hash,admin) VALUES($1,$2,$3,true)")
            .bind(Uuid::new_v4())
            .bind(name)
            .bind(password_hash)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        eprintln!("Administrator initialized. You can now start RainSync and sign in.");
        db.close().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_username_is_accepted() {
        assert_eq!(
            username(&["--username".into(), "fixture-admin".into()]).unwrap(),
            "fixture-admin"
        );
        for args in [
            vec![],
            vec!["--password".into(), "forbidden".into()],
            vec!["--username".into(), "admin".into(), "extra".into()],
        ] {
            assert!(username(&args).is_err());
        }
    }
    #[test]
    fn line_preserves_spaces_and_consumes_oversized_input() {
        assert_eq!(
            &**password_line(&mut std::io::Cursor::new(b"  fixture pass  \r\n")).unwrap(),
            "  fixture pass  "
        );
        let mut input =
            std::io::Cursor::new(format!("{}\nvalid-next-password\n", "a".repeat(4096)));
        assert!(password_line(&mut input).is_err());
        assert_eq!(&**password_line(&mut input).unwrap(), "valid-next-password");
        for value in [
            b"short\n".as_slice(),
            b"invalid\tpassword\n",
            b"invalid\xffpassword\n",
            b"without-newline",
        ] {
            assert!(password_line(&mut std::io::Cursor::new(value)).is_err());
        }
        assert_eq!(
            password_line(&mut std::io::Cursor::new(format!(
                "{}\r\n",
                "a".repeat(1024)
            )))
            .unwrap()
            .len(),
            1024
        );
        assert!(
            password_line(&mut std::io::Cursor::new(format!("{}\n", "a".repeat(1025)))).is_err()
        );
    }
}
