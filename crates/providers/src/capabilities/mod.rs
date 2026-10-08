//! Small concrete provider capabilities. Acquiring one is dispatch only and
//! confers no source, account, room or network authority.
//!
//! Browse owns catalog discovery; probe is read-only metadata; negotiation may
//! allocate an upstream play session owned by the caller; media reads retain
//! the controlled GET/HEAD transport. There is no catch-all Provider trait.
mod browse;
mod negotiate;
mod probe;

pub use crate::media_request::MediaRead;
pub use browse::Browse;
pub use negotiate::UpstreamNegotiation;
pub use probe::UpstreamProbe;
