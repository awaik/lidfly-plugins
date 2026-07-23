use std::path::Path;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use url::Url;

use crate::models::ClientError;

const QUERY_VALUE_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

pub fn build_codex_plugin_uri(marketplace_manifest: &Path) -> Result<Url, ClientError> {
    let path = marketplace_manifest.to_string_lossy();
    let bytes = path.as_bytes();
    let is_windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if !marketplace_manifest.is_absolute() && !is_windows_absolute {
        return Err(ClientError::new(
            "marketplace_path_not_absolute",
            "Codex deep link требует абсолютный путь к marketplace.json.",
        ));
    }
    let encoded = utf8_percent_encode(&path, QUERY_VALUE_ENCODE_SET).to_string();
    let mut url = Url::parse("codex://plugins/lidfly").map_err(|error| {
        ClientError::new(
            "invalid_codex_uri",
            format!("Не удалось собрать Codex URI: {error}"),
        )
    })?;
    url.set_query(Some(&format!("marketplacePath={encoded}")));
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::build_codex_plugin_uri;
    use std::path::Path;

    #[test]
    fn encodes_macos_spaces_and_cyrillic() {
        let uri = build_codex_plugin_uri(Path::new(
            "/Users/Иван Петров/Library/Application Support/LidFly/marketplace.json",
        ))
        .expect("valid absolute path")
        .to_string();
        assert_eq!(
            uri,
            "codex://plugins/lidfly?marketplacePath=%2FUsers%2F%D0%98%D0%B2%D0%B0%D0%BD%20%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2%2FLibrary%2FApplication%20Support%2FLidFly%2Fmarketplace.json"
        );
    }

    #[test]
    fn encodes_windows_drive_and_backslashes() {
        let uri = build_codex_plugin_uri(Path::new(
            r"C:\Users\Иван Петров\AppData\Roaming\LidFly\marketplace.json",
        ))
        .expect("valid Windows path represented for the URI test")
        .to_string();
        assert!(uri.contains("marketplacePath=C%3A%5CUsers%5C"));
        assert!(uri.contains("%20"));
        assert!(!uri.contains('+'));
    }

    #[test]
    fn rejects_relative_path() {
        assert!(build_codex_plugin_uri(Path::new("marketplace.json")).is_err());
    }
}
