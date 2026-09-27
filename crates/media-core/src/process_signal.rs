//! Service termination signals. Closing a Windows console has an OS deadline,
//! so it must not spend the normal grace period waiting for HTTP consumers.
#[derive(Clone, Copy)]
pub enum Reason {
    Normal,
    ConsoleClose,
}

impl Reason {
    pub fn http_grace(self) -> std::time::Duration {
        match self {
            Self::Normal => std::time::Duration::from_secs(10),
            Self::ConsoleClose => std::time::Duration::ZERO,
        }
    }
}

pub async fn wait() -> std::io::Result<Reason> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map(|_| Reason::Normal),
            _ = terminate.recv() => Ok(Reason::Normal),
        }
    }
    #[cfg(windows)]
    {
        let mut interrupt = tokio::signal::windows::ctrl_break()?;
        let mut close = tokio::signal::windows::ctrl_close()?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map(|_| Reason::Normal),
            _ = interrupt.recv() => Ok(Reason::Normal),
            _ = close.recv() => Ok(Reason::ConsoleClose),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        tokio::signal::ctrl_c().await.map(|_| Reason::Normal)
    }
}
