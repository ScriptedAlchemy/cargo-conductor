#[cfg(feature = "broken")]
compile_error!("intentional eval failure in broken-crate");

pub fn broken_marker() -> &'static str {
    "broken"
}
