use std::path::Path;

use percent_encoding::utf8_percent_encode;
use url::Url;

use crate::codex_uri::QUERY_VALUE_ENCODE_SET;
use crate::models::ClientError;

/// Документированный deep link Claude Desktop: открывает Cowork на заданной
/// папке с предзаполненным (но не выполняемым автоматически) промптом.
pub fn build_claude_cowork_uri(folder: &Path, prompt: &str) -> Result<Url, ClientError> {
    let path = folder.to_string_lossy();
    let bytes = path.as_bytes();
    let is_windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if !folder.is_absolute() && !is_windows_absolute {
        return Err(ClientError::new(
            "claude_folder_not_absolute",
            "Claude deep link требует абсолютный путь к папке LidFly.",
        ));
    }
    let encoded_folder = utf8_percent_encode(&path, QUERY_VALUE_ENCODE_SET).to_string();
    let encoded_prompt = utf8_percent_encode(prompt, QUERY_VALUE_ENCODE_SET).to_string();
    let mut url = Url::parse("claude://cowork/new").map_err(|error| {
        ClientError::new(
            "invalid_claude_uri",
            format!("Не удалось собрать Claude URI: {error}"),
        )
    })?;
    url.set_query(Some(&format!("folder={encoded_folder}&q={encoded_prompt}")));
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::build_claude_cowork_uri;
    use std::path::Path;

    #[test]
    fn encodes_macos_folder_and_russian_prompt() {
        let uri = build_claude_cowork_uri(
            Path::new("/Users/Иван Петров/LidFly"),
            "Прочитай CLAUDE.md и помоги начать",
        )
        .expect("valid absolute path")
        .to_string();
        assert!(uri.starts_with("claude://cowork/new?folder=%2FUsers%2F"));
        assert!(uri.contains("&q=%D0%9F%D1%80%D0%BE%D1%87%D0%B8%D1%82%D0%B0%D0%B9%20CLAUDE.md"));
        assert!(!uri.contains('+'));
    }

    #[test]
    fn encodes_windows_folder() {
        let uri = build_claude_cowork_uri(Path::new(r"C:\Users\Иван Петров\LidFly"), "start")
            .expect("valid Windows path represented for the URI test")
            .to_string();
        assert!(uri.contains("folder=C%3A%5CUsers%5C"));
        assert!(uri.ends_with("&q=start"));
    }

    #[test]
    fn escapes_query_separators_in_prompt() {
        let uri = build_claude_cowork_uri(Path::new("/tmp/LidFly"), "a&b=c?d")
            .expect("valid path")
            .to_string();
        assert!(uri.ends_with("&q=a%26b%3Dc%3Fd"));
    }

    #[test]
    fn rejects_relative_folder() {
        assert!(build_claude_cowork_uri(Path::new("LidFly"), "hi").is_err());
    }
}
