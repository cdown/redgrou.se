pub const HEALTH_ROUTE: &str = "/health";
pub const UPLOAD_ROUTE: &str = "/api/uploads";
pub const UPLOAD_DETAILS_ROUTE: &str = "/api/uploads/{upload_id}";
pub const UPLOAD_COUNT_ROUTE: &str = "/api/uploads/{upload_id}/count";
pub const UPLOAD_SIGHTINGS_ROUTE: &str = "/api/uploads/{upload_id}/sightings";
pub const TILE_ROUTE: &str = "/api/tiles/{upload_id}/{z}/{x}/{y}";
pub const FIELDS_ROUTE: &str = "/api/fields";
pub const FIELD_VALUES_ROUTE: &str = "/api/uploads/{upload_id}/fields/{field}";

pub const DEFAULT_PAGE_SIZE: u32 = 100;
pub const MAX_PAGE_SIZE: u32 = 500;
