use std::env;

/// Parses the port number from environment variables.
/// Checks PORT first, then REDGROUSE_BACKEND_PORT, defaulting to 3001.
/// Returns an error if the port value is invalid.
pub fn parse_port() -> anyhow::Result<u16> {
    let port_str = env::var("PORT")
        .or_else(|_| env::var("REDGROUSE_BACKEND_PORT"))
        .unwrap_or_else(|_| "3001".to_string());
    port_str.parse::<u16>().map_err(|e| {
        anyhow::anyhow!(
            "Invalid port value '{}': {}. Port must be a number between 1 and 65535",
            port_str,
            e
        )
    })
}
