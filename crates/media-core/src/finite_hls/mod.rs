//! Versioned finite clear HLS source admission and physical timestamp mapping.
//! This is separate from the frozen static-fMP4 output/capture grammar. A parsed
//! playlist is a plan, never decode evidence or source authorization.
mod fmp4;
mod manifest;
pub use fmp4::{Fmp4Normalizer, Fmp4SegmentMapping};
mod probe;
mod recipe;
pub use recipe::constrain_hls_recipe;
mod transport_stream;
pub use manifest::{Container, Master, MediaPlaylist, Segment, Variant, parse_master, parse_media};
pub use probe::{DecodedSegment, decode_fmp4_owned, decode_transport_stream};
pub use transport_stream::{NormalizedSegment, TimestampMap, normalize_transport_stream};
pub const VERSION: u32 = 1;
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_SEGMENTS: usize = 64;
pub const MAX_SECONDS: f64 = 300.0;
pub const MAX_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
#[cfg(all(test, target_os = "linux"))]
mod fixtures;
