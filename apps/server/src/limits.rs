pub const DEFAULT_SESSION_LIMIT: i64 = 2;
pub const DEFAULT_QUEUE_LIMIT: i64 = 20;

fn parse(value: Option<&str>, default: i64) -> anyhow::Result<i64> {
    let limit = value.map(str::parse::<i64>).transpose()?.unwrap_or(default);
    anyhow::ensure!(
        (1..=10000).contains(&limit),
        "limit must be between 1 and 10000"
    );
    Ok(limit)
}

pub fn configured(name: &str, default: i64) -> anyhow::Result<i64> {
    use anyhow::Context;
    let value = match std::env::var(name) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => return Err(error).with_context(|| format!("invalid {name}")),
    };
    parse(value.as_deref(), default).with_context(|| format!("invalid {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_limits_have_explicit_defaults_and_reject_invalid_configuration() {
        assert_eq!(parse(None, DEFAULT_SESSION_LIMIT).unwrap(), 2);
        assert_eq!(parse(None, DEFAULT_QUEUE_LIMIT).unwrap(), 20);
        assert_eq!(parse(Some("8"), DEFAULT_SESSION_LIMIT).unwrap(), 8);
        for value in ["", "0", "-1", "10001", "1.5", "oops"] {
            assert!(parse(Some(value), DEFAULT_QUEUE_LIMIT).is_err());
        }
    }
}
