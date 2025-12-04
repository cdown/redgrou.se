use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::BytesMut;
use prost::Message;

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
        self.0
            .encode(&mut buf)
            .expect("failed to encode protobuf message");
        Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/x-protobuf"),
            )
            .body(Body::from(buf.freeze()))
            .expect("failed to build protobuf response")
    }
}
