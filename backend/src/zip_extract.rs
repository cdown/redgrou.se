use crate::error::ApiError;
use std::io::{Cursor, Read};
use std::time::Duration;
use tokio::io::AsyncRead;
use zip::ZipArchive;

const MAX_COMPRESSED_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
const MAX_UNCOMPRESSED_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_IN_ZIP: usize = 1; // Birda exports contain exactly one CSV
const DECOMPRESSION_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ExtractedCsv {
    pub filename: String,
    pub data: Vec<u8>,
}

pub async fn extract_csv_from_zip<R>(
    reader: R,
    compressed_size: u64,
) -> Result<ExtractedCsv, ApiError>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    if compressed_size > MAX_COMPRESSED_SIZE {
        return Err(ApiError::bad_request("ZIP file exceeds 50 MB upload limit"));
    }

    use tokio::io::AsyncReadExt;
    let mut buffer = Vec::new();
    let mut limited_reader = reader.take(MAX_COMPRESSED_SIZE);
    limited_reader
        .read_to_end(&mut buffer)
        .await
        .map_err(|e| ApiError::internal(format!("Failed to read ZIP stream: {}", e)))?;

    tokio::time::timeout(
        DECOMPRESSION_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            extract_csv_from_zip_sync(Cursor::new(buffer), compressed_size)
        }),
    )
    .await
    .map_err(|_| ApiError::bad_request("ZIP decompression timed out"))?
    .map_err(|e| ApiError::internal(format!("Failed to spawn zip extraction task: {}", e)))?
}

fn extract_csv_from_zip_sync<R: Read + std::io::Seek>(
    reader: R,
    _compressed_size: u64,
) -> Result<ExtractedCsv, ApiError> {
    let mut archive = ZipArchive::new(reader)
        .map_err(|e| ApiError::bad_request(format!("Invalid ZIP file: {}", e)))?;

    if archive.len() != MAX_FILES_IN_ZIP {
        return Err(ApiError::bad_request(format!(
            "ZIP must contain exactly 1 file, found {}",
            archive.len()
        )));
    }

    let file = archive
        .by_index(0)
        .map_err(|e| ApiError::bad_request(format!("Failed to read ZIP entry: {}", e)))?;

    let filename = file.name().to_string();
    let uncompressed_size = file.size();

    if file.is_dir() {
        return Err(ApiError::bad_request(
            "ZIP contains a directory, expected a CSV file",
        ));
    }

    if !filename.to_lowercase().ends_with(".csv") {
        return Err(ApiError::bad_request(format!(
            "ZIP must contain a CSV file, found: {}",
            filename
        )));
    }

    if uncompressed_size > MAX_UNCOMPRESSED_SIZE {
        return Err(ApiError::bad_request(
            "CSV uncompressed size exceeds 50 MB limit",
        ));
    }

    // Use a smaller initial capacity to avoid wasting memory on false headers
    let mut data = Vec::with_capacity(uncompressed_size.min(1024 * 1024) as usize);
    let mut limited = file.take(MAX_UNCOMPRESSED_SIZE);
    limited
        .read_to_end(&mut data)
        .map_err(|e| ApiError::bad_request(format!("Failed to extract CSV data: {}", e)))?;

    let actual_size = data.len() as u64;

    // Validate that actual decompressed size matches header claim (within reason)
    // Allow up to 10% variance for metadata/padding
    if uncompressed_size > 0 {
        let size_ratio = if actual_size > uncompressed_size {
            actual_size as f64 / uncompressed_size as f64
        } else {
            uncompressed_size as f64 / actual_size as f64
        };

        if size_ratio > 1.1 {
            return Err(ApiError::bad_request(format!(
                "ZIP header mismatch: claimed {} bytes, actual {} bytes (possible tampering)",
                uncompressed_size, actual_size
            )));
        }
    }

    Ok(ExtractedCsv { filename, data })
}
