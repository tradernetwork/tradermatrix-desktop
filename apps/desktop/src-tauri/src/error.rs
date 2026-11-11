#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(String),
    #[error("database error: {0}")]
    Db(String),
    #[error("secret store error: {0}")]
    Secret(String),
    #[error("wrong vault passphrase")]
    WrongPassphrase,
    #[error("vault file is corrupt: {0}")]
    Corrupt(String),
    #[error("vault file is missing")]
    Missing,
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<sqlx::migrate::MigrateError> for AppError {
    fn from(e: sqlx::migrate::MigrateError) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}
