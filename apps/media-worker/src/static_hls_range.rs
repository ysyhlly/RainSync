//! Strict single-range syntax shared only by the static-HLS readers.
//! Method, conditions, authorization and resource-size checks stay at each boundary.
use axum::http::{HeaderMap, header};
use media_core::static_hls::ReadRange;

pub(super) fn parse(headers: &HeaderMap) -> Result<Option<ReadRange>, ()> {
    let mut values = headers.get_all(header::RANGE).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() || value.as_bytes().len() > 128 {
        return Err(());
    }
    let value = value.to_str().map_err(|_| ())?.trim();
    let bounds = value.strip_prefix("bytes=").ok_or(())?;
    let (first, last) = bounds.split_once('-').ok_or(())?;
    let number = |value: &str| -> Result<usize, ()> {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return Err(());
        }
        value.parse().map_err(|_| ())
    };
    let range = if first.is_empty() {
        ReadRange::Suffix(number(last)?)
    } else if last.is_empty() {
        ReadRange::From(number(first)?)
    } else {
        let first = number(first)?;
        let last = number(last)?;
        if first > last {
            return Err(());
        }
        ReadRange::Inclusive { first, last }
    };
    Ok(Some(range))
}
