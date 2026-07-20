use std::env;
use std::fs;
use std::process::ExitCode;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let artifact = arguments
        .next()
        .ok_or_else(|| "usage: verify-updater-signature <artifact> <signature>".to_owned())?;
    let signature_path = arguments
        .next()
        .ok_or_else(|| "usage: verify-updater-signature <artifact> <signature>".to_owned())?;
    if arguments.next().is_some() {
        return Err("usage: verify-updater-signature <artifact> <signature>".to_owned());
    }
    let encoded_public_key = env::var("TAURI_UPDATER_PUBLIC_KEY")
        .map_err(|_| "TAURI_UPDATER_PUBLIC_KEY is required".to_owned())?;
    let decoded_public_key = base64::engine::general_purpose::STANDARD
        .decode(encoded_public_key.trim())
        .map_err(|error| format!("invalid Tauri updater public key encoding: {error}"))?;
    let public_key_text = std::str::from_utf8(&decoded_public_key)
        .map_err(|error| format!("Tauri updater public key is not UTF-8: {error}"))?;
    let public_key = PublicKey::decode(public_key_text)
        .map_err(|error| format!("invalid Tauri updater public key: {error}"))?;

    let encoded_signature = fs::read_to_string(&signature_path)
        .map_err(|error| format!("cannot read updater signature {signature_path}: {error}"))?;
    let decoded_signature = base64::engine::general_purpose::STANDARD
        .decode(encoded_signature.trim())
        .map_err(|error| format!("invalid updater signature encoding: {error}"))?;
    let signature_text = std::str::from_utf8(&decoded_signature)
        .map_err(|error| format!("updater signature is not UTF-8: {error}"))?;
    let signature = Signature::decode(signature_text)
        .map_err(|error| format!("invalid updater signature: {error}"))?;

    let bytes = fs::read(&artifact)
        .map_err(|error| format!("cannot read updater artifact {artifact}: {error}"))?;
    public_key
        .verify(&bytes, &signature, true)
        .map_err(|error| format!("updater signature verification failed: {error}"))?;
    println!("Updater signature verified: {artifact}");
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
