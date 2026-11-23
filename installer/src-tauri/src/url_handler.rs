//! Проверка, что в системе зарегистрировано приложение для URL-схемы.
//!
//! `tauri-plugin-opener` не сообщает об отсутствии обработчика: на Windows
//! ShellExecute показывает системное окно «Вам понадобится новое приложение»
//! и возвращает успех, а на macOS `/usr/bin/open` запускается detached. Поэтому
//! перед открытием `codex://` наличие обработчика проверяется отдельно.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandlerStatus {
    Registered,
    Missing,
    /// Платформа без надёжной проверки: открываем ссылку как раньше.
    Unknown,
}

pub fn url_scheme_handler(scheme: &str) -> HandlerStatus {
    platform::url_scheme_handler(scheme)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::HandlerStatus;
    use windows_sys::Win32::UI::Shell::{
        AssocQueryStringW, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCF_IS_PROTOCOL, ASSOCSTR, ASSOCSTR_APPID,
        ASSOCSTR_COMMAND, ASSOCSTR_EXECUTABLE,
    };

    const S_OK: i32 = 0;
    const S_FALSE: i32 = 1;

    /// ASSOCF_IS_PROTOCOL учитывает и классическую регистрацию в реестре, и
    /// пакетные приложения Microsoft Store (Codex для Windows ставится оттуда):
    /// у них нет командной строки, но есть AppUserModelID (`ASSOCSTR_APPID`).
    pub fn url_scheme_handler(scheme: &str) -> HandlerStatus {
        let scheme: Vec<u16> = scheme.encode_utf16().chain(Some(0)).collect();
        let registered = [ASSOCSTR_COMMAND, ASSOCSTR_EXECUTABLE, ASSOCSTR_APPID]
            .into_iter()
            .filter_map(|kind| query(&scheme, kind))
            .any(|value| is_real_handler(&value));
        if registered {
            HandlerStatus::Registered
        } else {
            HandlerStatus::Missing
        }
    }

    fn query(scheme: &[u16], kind: ASSOCSTR) -> Option<String> {
        let flags = ASSOCF_IS_PROTOCOL | ASSOCF_INIT_IGNOREUNKNOWN;
        let mut len: u32 = 0;
        // SAFETY: строка схемы завершается нулём; при pszout = null функция
        // только записывает требуемую длину в `len`.
        let hr = unsafe {
            AssocQueryStringW(
                flags,
                kind,
                scheme.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                &mut len,
            )
        };
        if (hr != S_OK && hr != S_FALSE) || len <= 1 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize];
        // SAFETY: буфер имеет ровно `len` элементов, о которых сообщила система.
        let hr = unsafe {
            AssocQueryStringW(
                flags,
                kind,
                scheme.as_ptr(),
                std::ptr::null(),
                buffer.as_mut_ptr(),
                &mut len,
            )
        };
        if hr != S_OK {
            return None;
        }
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }

    /// Системный диалог «найти приложение» (OpenWith.exe) не считается
    /// обработчиком: именно его клиент видит, когда Codex не установлен.
    fn is_real_handler(value: &str) -> bool {
        let value = value.trim();
        !value.is_empty() && !value.to_ascii_lowercase().contains("openwith.exe")
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::HandlerStatus;
    use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFTypeRef};
    use core_foundation_sys::error::CFErrorRef;
    use core_foundation_sys::string::kCFStringEncodingUTF8;
    use core_foundation_sys::url::{CFURLCreateWithBytes, CFURLRef};

    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultApplicationURLForURL(
            in_url: CFURLRef,
            in_role_mask: u32,
            out_error: *mut CFErrorRef,
        ) -> CFURLRef;
    }

    pub fn url_scheme_handler(scheme: &str) -> HandlerStatus {
        let probe = format!("{scheme}://");
        // SAFETY: CoreFoundation-объекты создаются и освобождаются по правилу
        // Create/Copy; ошибку LaunchServices не запрашиваем (null).
        unsafe {
            let url = CFURLCreateWithBytes(
                kCFAllocatorDefault,
                probe.as_ptr(),
                probe.len() as _,
                kCFStringEncodingUTF8,
                std::ptr::null(),
            );
            if url.is_null() {
                return HandlerStatus::Unknown;
            }
            let app = LSCopyDefaultApplicationURLForURL(url, K_LS_ROLES_ALL, std::ptr::null_mut());
            CFRelease(url as CFTypeRef);
            if app.is_null() {
                HandlerStatus::Missing
            } else {
                CFRelease(app as CFTypeRef);
                HandlerStatus::Registered
            }
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::HandlerStatus;

    pub fn url_scheme_handler(_scheme: &str) -> HandlerStatus {
        HandlerStatus::Unknown
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{url_scheme_handler, HandlerStatus};

    #[test]
    fn detects_system_handler_and_missing_scheme() {
        assert_eq!(url_scheme_handler("https"), HandlerStatus::Registered);
        assert_eq!(
            url_scheme_handler("lidfly-no-such-scheme-4f0c"),
            HandlerStatus::Missing
        );
    }
}
