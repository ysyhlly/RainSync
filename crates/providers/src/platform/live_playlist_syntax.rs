//! Shared pure syntax for the closed live-playlist adapters.
//! URL scope, rolling-window freshness and playlist policy remain provider-owned.
use super::bilibili::Error;

type Result<T> = std::result::Result<T, Error>;

pub(super) const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

pub(super) fn invalid() -> Error {
    Error::InvalidResponse("live_playlist_shape")
}
pub(super) fn integer(s: &str) -> Result<u64> {
    if s.is_empty()
        || s.len() > 16
        || !s.bytes().all(|b| b.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(invalid());
    }
    let n = s.parse::<u64>().map_err(|_| invalid())?;
    if n > MAX_SEQUENCE {
        return Err(invalid());
    }
    Ok(n)
}
pub(super) fn duration(s: &str) -> Result<u32> {
    if s.is_empty()
        || s.len() > 16
        || !s.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        || s.bytes().filter(|b| *b == b'.').count() > 1
    {
        return Err(invalid());
    }
    let value = s.parse::<f64>().map_err(|_| invalid())?;
    if !value.is_finite() || !(0.001..=30.0).contains(&value) {
        return Err(invalid());
    }
    let millis = (value * 1000.0).round();
    if (value * 1000.0 - millis).abs() > 0.001 {
        return Err(Error::Restricted("live_submillisecond_duration_denied"));
    }
    Ok(millis as u32)
}

/// Strict RFC3339 milliseconds for source validation only. The first slice does
/// not expose a frame-aligned time map merely because a playlist supplies PDT.
pub(crate) fn parse_program_date_time(value: &str) -> Result<i64> {
    if !value.is_ascii() || !(20..=29).contains(&value.len()) {
        return Err(invalid());
    }
    let b = value.as_bytes();
    if b.get(4) != Some(&b'-')
        || b.get(7) != Some(&b'-')
        || b.get(10) != Some(&b'T')
        || b.get(13) != Some(&b':')
        || b.get(16) != Some(&b':')
    {
        return Err(invalid());
    }
    let number = |start: usize, end: usize| -> Result<i64> {
        let s = value.get(start..end).ok_or_else(invalid)?;
        if !s.bytes().all(|n| n.is_ascii_digit()) {
            return Err(invalid());
        }
        s.parse().map_err(|_| invalid())
    };
    let (year, month, day, hour, minute, second) = (
        number(0, 4)?,
        number(5, 7)?,
        number(8, 10)?,
        number(11, 13)?,
        number(14, 16)?,
        number(17, 19)?,
    );
    if !(2000..=2099).contains(&year)
        || !(1..=12).contains(&month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(invalid());
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maxday = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=maxday).contains(&day) {
        return Err(invalid());
    }
    let mut index = 19;
    let mut fraction = 0;
    if b.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while b.get(index).is_some_and(|n| n.is_ascii_digit()) {
            index += 1;
        }
        let count = index - start;
        if !(1..=3).contains(&count) {
            return Err(invalid());
        }
        fraction = number(start, index)? * 10i64.pow((3 - count) as u32);
    }
    let offset = match b.get(index) {
        Some(b'Z') if index + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if index + 6 == b.len() && b[index + 3] == b':' => {
            let h = number(index + 1, index + 3)?;
            let m = number(index + 4, index + 6)?;
            if h > 14 || m > 59 || h == 14 && m != 0 {
                return Err(invalid());
            }
            (h * 3600 + m * 60) * if *sign == b'+' { 1 } else { -1 }
        }
        _ => return Err(invalid()),
    };
    // Gregorian days from civil, epoch 1970-01-01 (Howard Hinnant algorithm).
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok(
        ((era * 146097 + doe - 719468) * 86400 + hour * 3600 + minute * 60 + second - offset)
            * 1000
            + fraction,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{bilibili::live, other_live};

    #[test]
    fn sequence_and_duration_syntax_keep_their_exact_boundaries() {
        for (value, expected) in [("0", 0), ("1", 1), ("9007199254740991", MAX_SEQUENCE)] {
            assert_eq!(integer(value), Ok(expected), "{value}");
        }
        for value in [
            "",
            "00",
            "01",
            "+1",
            "-1",
            "1.0",
            " 1",
            "１",
            "9007199254740992",
            "10000000000000000",
        ] {
            assert_eq!(integer(value), Err(invalid()), "{value}");
        }
        for (value, expected) in [
            ("0.001", 1),
            (".5", 500),
            ("1.", 1000),
            ("01.250", 1250),
            ("30", 30000),
        ] {
            assert_eq!(duration(value), Ok(expected), "{value}");
        }
        for value in [
            "",
            ".",
            "0",
            "0.0009",
            "30.001",
            "1..0",
            "+1",
            "1e0",
            "NaN",
            " 1",
            "１",
            "1.000000000000000",
        ] {
            assert_eq!(duration(value), Err(invalid()), "{value}");
        }
        assert_eq!(
            duration("0.0011"),
            Err(Error::Restricted("live_submillisecond_duration_denied"))
        );
    }

    #[test]
    fn program_date_time_entry_points_keep_dates_offsets_and_milliseconds() {
        let parsers: [fn(&str) -> Result<i64>; 2] = [
            live::playlist::parse_program_date_time,
            other_live::playlist::parse_program_date_time,
        ];
        for parse in parsers {
            for (value, expected) in [
                ("2000-01-01T00:00:00Z", 946_684_800_000),
                ("2000-02-29T00:00:00Z", 951_782_400_000),
                ("2099-12-31T23:59:59.999Z", 4_102_444_799_999),
                ("2000-01-01T14:00:00+14:00", 946_684_800_000),
                ("2000-01-01T00:00:00-14:00", 946_735_200_000),
                ("2000-01-01T00:00:00.1Z", 946_684_800_100),
                ("2000-01-01T00:00:00.12Z", 946_684_800_120),
                ("2000-01-01T00:00:00.123+00:00", 946_684_800_123),
            ] {
                assert_eq!(parse(value), Ok(expected), "{value}");
            }
            for value in [
                "1999-12-31T23:59:59Z",
                "2100-01-01T00:00:00Z",
                "2001-02-29T00:00:00Z",
                "2000-04-31T00:00:00Z",
                "2000-00-01T00:00:00Z",
                "2000-01-00T00:00:00Z",
                "2000-01-01T24:00:00Z",
                "2000-01-01T00:60:00Z",
                "2000-01-01T00:00:60Z",
                "2000-01-01T00:00:00+14:01",
                "2000-01-01T00:00:00+15:00",
                "2000-01-01T00:00:00+00:60",
                "2000-01-01T00:00:00.Z",
                "2000-01-01T00:00:00.1234Z",
                "2000-01-01 00:00:00Z",
                "2000-01-01T00:00:00z",
                "2000-01-01T00:00:00Z ",
                "２０００-01-01T00:00:00Z",
            ] {
                assert_eq!(parse(value), Err(invalid()), "{value}");
            }
        }
    }

    #[test]
    fn both_live_playlist_parsers_keep_numeric_and_date_errors() {
        for (sequence, length, date, expected) in [
            (
                "0",
                "0.001",
                "2000-02-29T00:00:00Z",
                Ok((0, 1, Some(951_782_400_000))),
            ),
            (
                "9007199254740991",
                "30.000",
                "2000-01-01T00:00:00.123+00:00",
                Ok((MAX_SEQUENCE, 30000, Some(946_684_800_123))),
            ),
            ("01", "1", "2000-01-01T00:00:00Z", Err(invalid())),
            (
                "9007199254740992",
                "1",
                "2000-01-01T00:00:00Z",
                Err(invalid()),
            ),
            (
                "1",
                "0.0011",
                "2000-01-01T00:00:00Z",
                Err(Error::Restricted("live_submillisecond_duration_denied")),
            ),
            ("1", "1", "2001-02-29T00:00:00Z", Err(invalid())),
        ] {
            let input = format!(
                "#EXTM3U\n#EXT-X-TARGETDURATION:30\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n#EXT-X-PROGRAM-DATE-TIME:{date}\n#EXTINF:{length},\nsegment.ts\n"
            );
            let bilibili = live::parse_playlist(
                input.as_bytes(),
                "https://cn-gotcha01.bilivideo.com/live-bvc/123/index.m3u8",
            )
            .map(|p| {
                let s = &p.segments[0];
                (s.sequence, s.duration_ms, s.program_date_time_ms)
            });
            let other = other_live::parse_playlist(
                other_live::Provider::TikTok,
                input.as_bytes(),
                "https://pull.tiktokcdn.com/stage/stream-7/index.m3u8",
            )
            .map(|p| {
                let s = &p.segments[0];
                (s.sequence, s.duration_ms, s.program_date_time_ms)
            });
            assert_eq!(bilibili, expected, "Bilibili {sequence} {length} {date}");
            assert_eq!(other, expected, "TikTok {sequence} {length} {date}");
        }
    }
}
