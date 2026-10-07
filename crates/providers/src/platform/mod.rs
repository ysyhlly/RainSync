//! Server-side platform resolution. Raw media addresses and authentication
//! context stay on the server and must not be serialized into room events.
pub mod bilibili;
pub mod http;
pub mod imports;
mod live_playlist_syntax;
pub mod oauth;
pub mod short_video;
pub mod text;
pub mod youtube;

pub mod other_live;
