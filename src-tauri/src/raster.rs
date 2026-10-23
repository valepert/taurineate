//! Decoding input images and encoding them as PNM for the tracers.
//! potrace only reads PNM/BMP, so (like Delineate with JIU) we convert here.

use image::{DynamicImage, RgbImage};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

/// Keeps the last decoded image so moving a slider doesn't decode again.
#[derive(Default)]
pub struct Cache {
    entry: Option<(PathBuf, Option<SystemTime>, Arc<RgbImage>)>,
}

impl Cache {
    pub fn load(&mut self, path: &Path) -> Result<Arc<RgbImage>, String> {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Some((p, t, img)) = &self.entry {
            if p == path && *t == mtime {
                return Ok(img.clone());
            }
        }
        let img = Arc::new(flatten(image::open(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?));
        self.entry = Some((path.to_path_buf(), mtime, img.clone()));
        Ok(img)
    }
}

/// Composites any transparency over white, so transparent areas count as background.
fn flatten(img: DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let blend = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([blend(p[0]), blend(p[1]), blend(p[2])]));
    }
    out
}

/// Binary PBM (P4). Pixels darker than `threshold_percent` of full brightness become black (1).
pub fn to_pbm(img: &RgbImage, threshold_percent: f64) -> Vec<u8> {
    let (w, h) = img.dimensions();
    let cutoff = threshold_percent.clamp(0.0, 100.0) / 100.0 * 255.0;
    let row_bytes = w.div_ceil(8) as usize;
    let mut out = format!("P4\n{w} {h}\n").into_bytes();
    let header = out.len();
    out.resize(header + row_bytes * h as usize, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if luma(p) < cutoff {
            out[header + y as usize * row_bytes + x as usize / 8] |= 0x80 >> (x % 8);
        }
    }
    out
}

/// Perceived brightness (0-255), used by both the threshold and the histogram.
fn luma(p: &image::Rgb<u8>) -> f64 {
    0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64
}

/// Pixel count per brightness level, 256 bins.
pub fn luma_histogram(img: &RgbImage) -> Vec<u32> {
    let mut bins = vec![0u32; 256];
    for p in img.pixels() {
        bins[(luma(p).round() as usize).min(255)] += 1;
    }
    bins
}

/// Binary PPM (P6).
pub fn to_ppm(img: &RgbImage) -> Vec<u8> {
    let (w, h) = img.dimensions();
    let mut out = format!("P6\n{w} {h}\n255\n").into_bytes();
    out.extend_from_slice(img.as_raw());
    out
}

/// A PNG data URL of the (flattened) image, for showing the original in the webview.
pub fn png_data_url(img: &RgbImage) -> Result<String, String> {
    use base64::Engine as _;
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf.into_inner())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbm_header_and_bits() {
        // 10x2: left half black, right half white, so each row needs 2 bytes.
        let img = RgbImage::from_fn(10, 2, |x, _| if x < 5 { image::Rgb([0, 0, 0]) } else { image::Rgb([255, 255, 255]) });
        let pbm = to_pbm(&img, 50.0);
        let header = b"P4\n10 2\n";
        assert_eq!(&pbm[..header.len()], header);
        assert_eq!(&pbm[header.len()..], &[0b1111_1000, 0, 0b1111_1000, 0]);
    }

    #[test]
    fn threshold_moves_gray_pixels() {
        let img = RgbImage::from_pixel(1, 1, image::Rgb([128, 128, 128]));
        assert_eq!(*to_pbm(&img, 60.0).last().unwrap(), 0x80);
        assert_eq!(*to_pbm(&img, 40.0).last().unwrap(), 0);
    }

    #[test]
    fn transparency_becomes_white() {
        let img = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 0])));
        assert_eq!(flatten(img).get_pixel(0, 0).0, [255, 255, 255]);
    }

    #[test]
    fn histogram_counts_every_pixel() {
        let img = RgbImage::from_fn(4, 1, |x, _| if x == 0 { image::Rgb([0, 0, 0]) } else { image::Rgb([255, 255, 255]) });
        let h = luma_histogram(&img);
        assert_eq!(h.len(), 256);
        assert_eq!((h[0], h[255], h.iter().sum::<u32>()), (1, 3, 4));
    }

    #[test]
    fn ppm_layout() {
        let img = RgbImage::from_pixel(2, 1, image::Rgb([1, 2, 3]));
        assert_eq!(to_ppm(&img), b"P6\n2 1\n255\n\x01\x02\x03\x01\x02\x03".to_vec());
    }
}
