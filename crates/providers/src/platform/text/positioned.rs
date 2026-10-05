//! Mode 7 data-only subset: normalized coordinates, opacity, finite lifetime,
//! 2D rotation and one linear move. Unknown pixel/path/perspective shapes are
//! explicitly marked unsupported and retain only their plain text fallback.
use super::*;
pub fn parse(raw: &str) -> Result<(String, Option<DanmakuPosition>, bool)> {
    let text = advanced_plain_text(raw)?;
    let v: Vec<serde_json::Value> = serde_json::from_str(raw).map_err(|_| invalid())?;
    let position = (|| {
        if v.len() > 13 {
            return None;
        }
        let number = |i: usize| {
            v.get(i)
                .and_then(serde_json::Value::as_f64)
                .filter(|n| n.is_finite())
        };
        let coordinate = |i: usize| {
            number(i)
                .filter(|n| (0.0..=1.0).contains(n))
                .map(|n| (n * 10000.0).round() as u16)
        };
        let x = coordinate(0)?;
        let y = coordinate(1)?;
        let duration = number(3)
            .filter(|n| *n > 0.0 && *n <= 12.0)
            .map(|n| (n * 1000.0).round() as u32)
            .filter(|n| *n > 0)?;
        let opacity = v[2].as_str()?.split_once('-')?;
        let alpha = |s: &str| {
            s.parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
                .map(|n| (n * 1000.0).round() as u16)
        };
        let opacity_from = alpha(opacity.0)?;
        let opacity_to = alpha(opacity.1)?;
        let rotation = if v.len() > 5 {
            number(5)
                .filter(|n| (-360.0..=360.0).contains(n))
                .map(|n| n.round() as i16)?
        } else {
            0
        };
        // Perspective rotation and arbitrary paths are intentionally not approximated.
        if v.len() > 6 && number(6)? != 0.0 {
            return None;
        }
        let (to_x, to_y) = if v.len() > 8 {
            (coordinate(7)?, coordinate(8)?)
        } else if v.len() > 7 {
            return None;
        } else {
            (x, y)
        };
        let ms = |i: usize| {
            number(i)
                .filter(|n| *n >= 0.0 && *n <= 12000.0 && n.fract() == 0.0)
                .map(|n| n as u32)
        };
        let move_ms = if v.len() > 9 { ms(9)? } else { duration };
        let delay_ms = if v.len() > 10 { ms(10)? } else { 0 };
        if delay_ms.checked_add(move_ms)? > duration {
            return None;
        }
        Some(DanmakuPosition {
            x_permyriad: x,
            y_permyriad: y,
            to_x_permyriad: to_x,
            to_y_permyriad: to_y,
            duration_ms: duration,
            move_duration_ms: move_ms,
            move_delay_ms: delay_ms,
            opacity_from_permille: opacity_from,
            opacity_to_permille: opacity_to,
            rotation_z_deg: rotation,
        })
    })();
    let unsupported = position.is_none();
    Ok((text, position, unsupported))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finite_position_alpha_and_linear_move_are_normalized() {
        let (_, p, u) =
            parse(r#"[0.1,0.2,"1-0.5",4,"<script>plain",45,0,0.8,0.9,3000,500,true,"Arial"]"#)
                .unwrap();
        let p = p.unwrap();
        assert!(!u);
        assert_eq!(p.x_permyriad, 1000);
        assert_eq!(p.to_y_permyriad, 9000);
        assert_eq!(p.move_delay_ms, 500);
        assert_eq!(p.opacity_to_permille, 500);
    }
    #[test]
    fn unknown_pixel_path_perspective_and_bad_numeric_data_never_run() {
        for raw in [
            r#"[200,200,"1-1",4,"text"]"#,
            r#"[0,0,"1-1",4,"text",0,45]"#,
            r#"[0,0,"1-1",4,"text",0,0,1,1,3000,2000]"#,
            r#"[0,0,"NaN-1",4,"text"]"#,
            r#"[0,0,"1-1",4,"text",0,0,1,1,3000,0,true,"Arial",true,"M0 0"]"#,
        ] {
            let (t, p, u) = parse(raw).unwrap();
            assert_eq!(t, "text");
            assert!(p.is_none());
            assert!(u);
        }
    }
}
