use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::BytesMut;
use prost::Message;
use tracing::error;

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/redgrouse.api.rs"));
}

pub struct Proto<T>(pub T);

impl<T> Proto<T> {
    pub const fn new(inner: T) -> Self {
        Self(inner)
    }
}

impl<T: Message> IntoResponse for Proto<T> {
    fn into_response(self) -> Response {
        let mut buf = BytesMut::with_capacity(self.0.encoded_len());
        if let Err(err) = self.0.encode(&mut buf) {
            error!("Failed to encode protobuf message: {}", err);
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("Internal server error"))
                .unwrap_or_else(|_| {
                    // If building an error response fails, we're in a critical state
                    // This should never happen, but we need to return something
                    Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Body::empty())
                        .expect("Failed to build error response (critical failure)")
                });
        }
        Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/x-protobuf"),
            )
            .body(Body::from(buf.freeze()))
            .unwrap_or_else(|err| {
                error!("Failed to build protobuf response: {}", err);
                // If building an error response fails, we're in a critical state
                // This should never happen, but we need to return something
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::from("Internal server error"))
                    .expect("Failed to build error response (critical failure)")
            })
    }
}
