fn main() {
    println!("cargo:rerun-if-env-changed=LIDFLY_PLUGIN_CONTENT_PUBLIC_KEY_BASE64");
    tauri_build::build()
}
