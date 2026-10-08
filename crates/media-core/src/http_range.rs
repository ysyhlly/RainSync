//! Conservative single-range selection for local and NAS file delivery.
//! Unsupported or malformed Range fields are ignored. Only a valid byte range
//! that selects no bytes is unsatisfiable. A file's stat identity is not a
//! strong HTTP validator: callers must ignore Range when If-Range is present.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Request(Option<Spec>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Spec {
    From(u64, Option<u64>),
    Suffix(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Selection {
    Full,
    Partial(u64, u64),
    Unsatisfiable,
}

impl Request {
    pub fn parse(value: Option<&str>) -> Self {
        fn number(value: &str) -> Option<u64> {
            (!value.is_empty() && value.bytes().all(|v| v.is_ascii_digit()))
                .then(|| value.parse().ok())
                .flatten()
        }
        let Some(raw) = value
            .filter(|value| value.len() <= 128)
            .and_then(|value| value.strip_prefix("bytes="))
        else {
            return Self::default();
        };
        let Some((start, end)) = raw.split_once('-') else {
            return Self::default();
        };
        if start.is_empty() {
            return Self(number(end).map(Spec::Suffix));
        }
        let Some(start) = number(start) else {
            return Self::default();
        };
        let end = if end.is_empty() {
            None
        } else {
            let Some(end) = number(end).filter(|end| *end >= start) else {
                return Self::default();
            };
            Some(end)
        };
        Self(Some(Spec::From(start, end)))
    }

    /// Canonical, bounded wire form. Invalid/unsupported input never reaches an
    /// older Agent whose legacy parser would otherwise turn it into a 416.
    pub fn header_value(self) -> Option<String> {
        self.0.map(|spec| match spec {
            Spec::From(start, Some(end)) => format!("bytes={start}-{end}"),
            Spec::From(start, None) => format!("bytes={start}-"),
            Spec::Suffix(length) => format!("bytes=-{length}"),
        })
    }

    pub fn resolve(self, size: u64) -> Selection {
        match self.0 {
            None => Selection::Full,
            Some(Spec::Suffix(0)) => Selection::Unsatisfiable,
            Some(_) if size == 0 => Selection::Unsatisfiable,
            Some(Spec::Suffix(length)) => Selection::Partial(size.saturating_sub(length), size - 1),
            Some(Spec::From(start, _)) if start >= size => Selection::Unsatisfiable,
            Some(Spec::From(start, end)) => {
                Selection::Partial(start, end.unwrap_or(size - 1).min(size - 1))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_ranges_preserve_boundaries_and_empty_representation_semantics() {
        for (raw, expected) in [
            ("bytes=0-", Selection::Partial(0, 19)),
            ("bytes=3-9", Selection::Partial(3, 9)),
            ("bytes=19-99", Selection::Partial(19, 19)),
            ("bytes=-5", Selection::Partial(15, 19)),
            ("bytes=-500", Selection::Partial(0, 19)),
            ("bytes=-0", Selection::Unsatisfiable),
            ("bytes=20-", Selection::Unsatisfiable),
            ("bytes=18446744073709551615-", Selection::Unsatisfiable),
        ] {
            let request = Request::parse(Some(raw));
            assert_eq!(request.resolve(20), expected, "{raw}");
            assert_eq!(request.resolve(0), Selection::Unsatisfiable, "{raw}");
            assert_eq!(Request::parse(request.header_value().as_deref()), request);
        }
        assert_eq!(Request::default().resolve(0), Selection::Full);
        assert_eq!(
            Request::parse(Some("bytes=0-")).resolve(u64::MAX),
            Selection::Partial(0, u64::MAX - 1)
        );
    }

    #[test]
    fn malformed_and_unsupported_fields_are_full_not_unsatisfiable() {
        for raw in [
            "bytes=9-3",
            "bytes=0-2,4-8",
            "bytes=+1-2",
            "bytes=--5",
            "bytes=1-18446744073709551616",
            "bytes=-",
            "bytes=0- 2",
            "items=0-2",
            "bytes=0-2\r\nX: value",
        ] {
            let request = Request::parse(Some(raw));
            assert_eq!(request.resolve(20), Selection::Full, "{raw}");
            assert_eq!(request.resolve(0), Selection::Full, "{raw}");
            assert_eq!(request.header_value(), None, "{raw}");
        }
        assert_eq!(Request::parse(Some(&"0".repeat(129))), Request::default());
    }
}
