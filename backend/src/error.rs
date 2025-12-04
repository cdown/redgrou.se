use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub use crate::proto::pb::ApiErrorBody;
use crate::proto::Proto;

pub struct ApiError {
    pub status: StatusCode,
    pub body: ApiErrorBody,
}

impl ApiError {
    pub fn new(status: StatusCode, error: impl Into<String>) -> Self {
        Self {
            status,
            body: ApiErrorBody {
                error: error.into(),
                code: None,
            },
        }
    }

    pub fn with_code(
        status: StatusCode,
        error: impl Into<String>,
        code: impl Into<String>,
    ) -> Self {
        Self {
            status,
            body: ApiErrorBody {
                error: error.into(),
                code: Some(code.into()),
            },
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::with_code(StatusCode::NOT_FOUND, message, "NOT_FOUND")
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::with_code(StatusCode::BAD_REQUEST, message, "BAD_REQUEST")
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::with_code(StatusCode::INTERNAL_SERVER_ERROR, message, "INTERNAL_ERROR")
    }

    pub fn unauthorised(message: impl Into<String>) -> Self {
        Self::with_code(StatusCode::UNAUTHORIZED, message, "UNAUTHORISED")
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::with_code(StatusCode::FORBIDDEN, message, "FORBIDDEN")
    }

    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            message,
            "SERVICE_UNAVAILABLE",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Proto::new(self.body)).into_response()
    }
}
