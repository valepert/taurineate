//! Running a tracer binary. Only one trace runs at a time: starting a new one
//! kills the previous process, so live preview never queues up stale work.

use crate::raster;
use crate::tracers::{self, Engine, OptionValue};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

pub const CANCELLED: &str = "cancelled";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRequest {
    pub engine: Engine,
    pub input: PathBuf,
    pub values: HashMap<String, OptionValue>,
    /// Brightness threshold in percent, used for engines that need a bilevel image.
    #[serde(default = "default_threshold")]
    pub threshold: f64,
    /// The output file, only used to show a complete command (writing happens on Run).
    #[serde(default)]
    pub output: Option<PathBuf>,
}

fn default_threshold() -> f64 {
    50.0
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub svg: String,
    pub bytes: usize,
    pub paths: usize,
    pub colors: Vec<String>,
    pub millis: u128,
    pub command: String,
}

/// The running tracer process, tagged with a generation number.
#[derive(Default)]
pub struct Runner {
    slot: Mutex<(u64, Option<Child>)>,
}

pub fn trace(runner: &Runner, cache: &Mutex<raster::Cache>, binary: &Path, req: &TraceRequest) -> Result<TraceResult, String> {
    let started = Instant::now();
    let desc = tracers::descriptor(req.engine);
    let flags = tracers::build_args(&desc, &req.values)?;
    let command = shell_command(binary, req, &flags);
    let img = cache.lock().unwrap().load(&req.input)?;

    // potrace: thresholded PBM on stdin, SVG on stdout.
    // autotrace: PPM temp file (it picks the reader by extension), SVG on stdout.
    let (args, stdin, _tmp) = match req.engine {
        Engine::Potrace => {
            let mut args = vec!["--svg".to_string(), "--output".into(), "-".into()];
            args.extend(flags);
            (args, Some(raster::to_pbm(&img, req.threshold)), None)
        }
        Engine::Autotrace => {
            let mut tmp = tempfile::Builder::new().prefix("taurineate-").suffix(".ppm").tempfile().map_err(|e| e.to_string())?;
            tmp.write_all(&raster::to_ppm(&img)).map_err(|e| e.to_string())?;
            let mut args = vec!["--output-format".to_string(), "svg".into()];
            args.extend(flags);
            args.push(tmp.path().display().to_string());
            (args, None, Some(tmp))
        }
    };

    let svg = runner.run(binary, &args, stdin)?;
    Ok(TraceResult {
        bytes: svg.len(),
        paths: svg.matches("<path").count(),
        colors: fill_colors(&svg),
        millis: started.elapsed().as_millis(),
        command,
        svg,
    })
}

impl Runner {
    fn run(&self, binary: &Path, args: &[String], stdin: Option<Vec<u8>>) -> Result<String, String> {
        // Claim a generation (and kill the previous run) before spawning, so the newest request always wins.
        let generation = {
            let mut slot = self.slot.lock().unwrap();
            if let Some(mut previous) = slot.1.take() {
                let _ = previous.kill();
                let _ = previous.wait();
            }
            slot.0 += 1;
            slot.0
        };

        let mut child = Command::new(binary)
            .args(args)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot start {}: {e}", binary.display()))?;

        let writer = child.stdin.take().zip(stdin).map(|(mut pipe, bytes)| thread::spawn(move || pipe.write_all(&bytes)));
        let out = drain(child.stdout.take());
        let err = drain(child.stderr.take());

        {
            let mut slot = self.slot.lock().unwrap();
            if slot.0 != generation {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CANCELLED.into());
            }
            slot.1 = Some(child);
        }

        let status = loop {
            {
                let mut slot = self.slot.lock().unwrap();
                if slot.0 != generation {
                    return Err(CANCELLED.into());
                }
                if let Some(status) = slot.1.as_mut().and_then(|c| c.try_wait().transpose()) {
                    slot.1 = None;
                    break status.map_err(|e| e.to_string())?;
                }
            }
            thread::sleep(Duration::from_millis(5));
        };

        if let Some(w) = writer {
            let _ = w.join();
        }
        let stdout = out.join().unwrap_or_default();
        let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).trim().to_string();
        if !status.success() || stdout.is_empty() {
            return Err(if stderr.is_empty() { format!("{} exited with {status}", binary.display()) } else { stderr });
        }
        String::from_utf8(stdout).map_err(|e| e.to_string())
    }
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    })
}

/// A command equivalent to the trace that works when pasted in a terminal. The app pipes
/// its own PBM into potrace and gives AutoTrace a temp file, so neither argv is reusable:
/// potrace gets an ImageMagick step doing the same flatten/luma/threshold, AutoTrace the input file.
fn shell_command(binary: &Path, req: &TraceRequest, flags: &[String]) -> String {
    let tracer = std::iter::once(binary.display().to_string()).chain(flags.iter().cloned());
    let input = shell_quote(&req.input.display().to_string());
    let redirect = req.output.as_ref().map(|o| format!(" > {}", shell_quote(&o.display().to_string()))).unwrap_or_default();
    let command = match req.engine {
        Engine::Potrace => format!(
            "magick {input} -background white -alpha remove -grayscale Rec601Luma -threshold {}% pbm:- | {} --svg --output -",
            req.threshold,
            tracer.map(|a| shell_quote(&a)).collect::<Vec<_>>().join(" "),
        ),
        Engine::Autotrace => format!(
            "{} --output-format svg {input}",
            tracer.map(|a| shell_quote(&a)).collect::<Vec<_>>().join(" ")
        ),
    };
    command + &redirect
}

fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:%+,@".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Distinct `#rrggbb` fill colors used in the SVG (attribute or style), uppercase.
pub fn fill_colors(svg: &str) -> Vec<String> {
    let mut colors = BTreeSet::new();
    for (i, _) in svg.match_indices("fill") {
        let rest = svg[i + 4..].trim_start_matches([':', '=', '"', '\'', ' ']);
        if let Some(hex) = rest.strip_prefix('#') {
            let hex: String = hex.chars().take(6).collect();
            if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                colors.insert(hex.to_ascii_uppercase());
            }
        }
    }
    colors.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_only_when_needed() {
        assert_eq!(shell_quote("/opt/homebrew/bin/potrace"), "/opt/homebrew/bin/potrace");
        assert_eq!(shell_quote("/tmp/my scan.png"), "'/tmp/my scan.png'");
        assert_eq!(shell_quote("it's.png"), "'it'\\''s.png'");
    }

    #[test]
    fn command_redirects_to_output_file() {
        let req = TraceRequest {
            engine: Engine::Autotrace,
            input: "/tmp/in.png".into(),
            values: HashMap::new(),
            threshold: 50.0,
            output: Some("/tmp/my out.svg".into()),
        };
        let cmd = shell_command(Path::new("/usr/bin/autotrace"), &req, &[]);
        assert_eq!(cmd, "/usr/bin/autotrace --output-format svg /tmp/in.png > '/tmp/my out.svg'");
    }

    #[test]
    fn finds_fill_colors_in_attributes_and_styles() {
        let svg = r##"<g fill="#000000"><path style="fill:#ded6aa; stroke:none;"/><path fill='#DED6AA'/><path fill="none"/></g>"##;
        assert_eq!(fill_colors(svg), ["000000", "DED6AA"]);
    }

    /// Runs the real binaries on a generated image; skipped when a tracer isn't installed.
    #[test]
    fn traces_with_installed_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("disc.png");
        image::RgbImage::from_fn(64, 64, |x, y| {
            let (dx, dy) = (x as i32 - 32, y as i32 - 32);
            if dx * dx + dy * dy < 400 { image::Rgb([200, 30, 30]) } else { image::Rgb([255, 255, 255]) }
        })
        .save(&input)
        .unwrap();

        let (runner, cache) = (Runner::default(), Mutex::new(raster::Cache::default()));
        for engine in [Engine::Potrace, Engine::Autotrace] {
            let Some(binary) = crate::discover::find_binary(engine.binary()) else {
                eprintln!("skipping {}: not installed", engine.binary());
                continue;
            };
            let req = TraceRequest { engine, input: input.clone(), values: HashMap::new(), threshold: 50.0, output: None };
            let result = trace(&runner, &cache, &binary, &req).unwrap_or_else(|e| panic!("{}: {e}", engine.binary()));
            assert!(result.svg.contains("<svg"), "{}: {}", engine.binary(), result.svg);
            assert!(result.paths >= 1, "{}: no paths", engine.binary());

            // The displayed command must work when pasted in a shell (potrace's needs ImageMagick).
            if engine == Engine::Potrace && crate::discover::find_binary("magick").is_none() {
                continue;
            }
            let out = Command::new("/bin/sh").arg("-c").arg(&result.command).output().unwrap();
            let pasted = String::from_utf8_lossy(&out.stdout);
            assert!(out.status.success(), "{}: {}", result.command, String::from_utf8_lossy(&out.stderr));
            assert_eq!(pasted.matches("<path").count(), result.paths, "{}", result.command);
        }
    }

    #[test]
    fn newer_run_cancels_older_one() {
        let runner = std::sync::Arc::new(Runner::default());
        let slow = {
            let runner = runner.clone();
            thread::spawn(move || runner.run(Path::new("/bin/sleep"), &["5".into()], None))
        };
        thread::sleep(Duration::from_millis(200));
        let fast = runner.run(Path::new("/bin/echo"), &["hi".into()], None);
        assert_eq!(fast.unwrap().trim(), "hi");
        assert_eq!(slow.join().unwrap().unwrap_err(), CANCELLED);
    }
}
