//! Tracer descriptors (ported from Delineate's settings/parameters-*.xml) and
//! turning the values chosen in the UI into command-line arguments.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const POTRACE: &str = include_str!("../tracers/potrace.json");
const AUTOTRACE: &str = include_str!("../tracers/autotrace.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Potrace,
    Autotrace,
}

impl Engine {
    pub fn binary(self) -> &'static str {
        match self {
            Engine::Potrace => "potrace",
            Engine::Autotrace => "autotrace",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Number,
    Bool,
    Color,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionSpec {
    pub flag: String,
    pub label: String,
    pub kind: Kind,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub enabled: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    #[serde(default)]
    pub integer: bool,
    #[serde(default)]
    pub help: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Descriptor {
    pub engine: Engine,
    pub label: String,
    pub description: String,
    /// Delineate thresholds the raster itself before calling this tracer.
    #[serde(default)]
    pub threshold: bool,
    pub options: Vec<OptionSpec>,
}

/// One option as set in the UI. `value` is ignored for bool options.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionValue {
    pub enabled: bool,
    pub value: Option<serde_json::Value>,
}

pub fn descriptors() -> Vec<Descriptor> {
    // AutoTrace first, matching Delineate's tab order.
    vec![descriptor(Engine::Autotrace), descriptor(Engine::Potrace)]
}

pub fn descriptor(engine: Engine) -> Descriptor {
    let json = match engine {
        Engine::Potrace => POTRACE,
        Engine::Autotrace => AUTOTRACE,
    };
    serde_json::from_str(json).expect("bundled descriptor is valid JSON")
}

/// Builds the tracer flags (without input/output arguments) from UI values.
/// Unknown flags are ignored; options missing from `values` use their defaults.
pub fn build_args(desc: &Descriptor, values: &HashMap<String, OptionValue>) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    for spec in &desc.options {
        let set = values.get(&spec.flag);
        let enabled = set.map_or(spec.enabled, |v| v.enabled);
        // Non-optional numbers/colors are always passed; bools are flags that are on or off.
        if (spec.optional || spec.kind == Kind::Bool) && !enabled {
            continue;
        }
        let flag = format!("--{}", spec.flag);
        let value = set.and_then(|v| v.value.clone()).or_else(|| spec.default.clone());
        match spec.kind {
            Kind::Bool => args.push(flag),
            Kind::Number => {
                let n = value
                    .as_ref()
                    .and_then(json_number)
                    .ok_or_else(|| format!("{}: missing number", spec.label))?;
                let n = n.clamp(spec.min.unwrap_or(f64::MIN), spec.max.unwrap_or(f64::MAX));
                args.push(flag);
                args.push(if spec.integer { format!("{}", n.round() as i64) } else { format!("{n}") });
            }
            Kind::Color => {
                let hex = value
                    .as_ref()
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim_start_matches('#').to_ascii_uppercase())
                    .filter(|s| s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()))
                    .ok_or_else(|| format!("{}: expected a hex color like FFFFFF", spec.label))?;
                args.push(flag);
                args.push(hex);
            }
        }
    }
    Ok(args)
}

fn json_number(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn val(enabled: bool, value: serde_json::Value) -> OptionValue {
        OptionValue { enabled, value: Some(value) }
    }

    #[test]
    fn potrace_defaults() {
        let args = build_args(&descriptor(Engine::Potrace), &HashMap::new()).unwrap();
        assert_eq!(args, ["--alphamax", "1", "--turdsize", "2"]);
    }

    #[test]
    fn autotrace_defaults_skip_disabled_optionals() {
        let args = build_args(&descriptor(Engine::Autotrace), &HashMap::new()).unwrap();
        assert!(args.contains(&"--background-color".to_string()));
        assert!(args.contains(&"--despeckle-level".to_string()));
        assert!(!args.contains(&"--color-count".to_string()));
        assert!(!args.contains(&"--centerline".to_string()));
    }

    #[test]
    fn values_override_defaults_and_are_clamped() {
        let mut v = HashMap::new();
        v.insert("invert".into(), OptionValue { enabled: true, value: None });
        v.insert("turdsize".into(), val(true, json!(999)));
        v.insert("alphamax".into(), val(true, json!("0.5")));
        let args = build_args(&descriptor(Engine::Potrace), &v).unwrap();
        assert_eq!(args, ["--invert", "--alphamax", "0.5", "--turdsize", "50"]);
    }

    #[test]
    fn enabling_optional_number_and_color() {
        let mut v = HashMap::new();
        v.insert("color-count".into(), val(true, json!(8)));
        v.insert("background-color".into(), val(true, json!("#00ff00")));
        let args = build_args(&descriptor(Engine::Autotrace), &v).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("--color-count 8"));
        assert!(joined.contains("--background-color 00FF00"));
    }

    #[test]
    fn bad_color_is_an_error() {
        let mut v = HashMap::new();
        v.insert("background-color".into(), val(true, json!("nope")));
        assert!(build_args(&descriptor(Engine::Autotrace), &v).is_err());
    }
}
