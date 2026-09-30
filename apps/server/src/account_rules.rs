use crate::*;

/// Only account creation applies these rules. Login must accept legacy credentials.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewAccount {
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

pub fn valid_username(value: &str) -> bool {
    (1..=80).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

pub fn valid_password(value: &str) -> bool {
    (8..=1024).contains(&value.len()) && value.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

pub fn display_name(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > 50 || value.chars().any(char::is_control) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(Some(value.to_owned()))
}

impl NewAccount {
    pub fn validate(&self) -> Result<Option<String>> {
        if !valid_username(&self.username) || !valid_password(&self.password) {
            return Err(err(StatusCode::BAD_REQUEST, "username_or_password_invalid"));
        }
        display_name(self.display_name.as_deref())
    }
}

pub fn insert_error(error: sqlx::Error) -> Error {
    if error
        .as_database_error()
        .is_some_and(|e| e.constraint() == Some("users_username_key"))
    {
        err(StatusCode::CONFLICT, "username_taken")
    } else {
        error.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_credentials_are_ascii_and_password_spaces_are_significant() {
        for name in ["a", "A_0.-", &"x".repeat(80)] {
            assert!(valid_username(name));
        }
        for name in ["", "a b", "中", "x/y", &"x".repeat(81)] {
            assert!(!valid_username(name));
        }
        for password in ["        ", " 123456 ", &"x".repeat(1024)] {
            assert!(valid_password(password));
        }
        for password in [
            "1234567",
            "中文abcd1234",
            "abcd\t1234",
            "abcd\n1234",
            &"x".repeat(1025),
        ] {
            assert!(!valid_password(password));
        }
    }
    #[test]
    fn nicknames_count_unicode_scalars_and_blank_means_default() {
        assert_eq!(display_name(Some(" \t ")).unwrap(), None);
        assert_eq!(display_name(Some(" 雨😀 ")).unwrap(), Some("雨😀".into()));
        assert!(display_name(Some(&"😀".repeat(50))).is_ok());
        assert!(display_name(Some(&"😀".repeat(51))).is_err());
        assert!(display_name(Some("a\0b")).is_err());
    }
}
