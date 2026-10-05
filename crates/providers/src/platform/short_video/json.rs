//! Bounded JSON tree: duplicate keys are rejected at every depth before Value
//! can discard them. Errors expose neither third-party field names nor values.
use super::{Error, MAX_BODY, Result};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 100_000;
const MAX_OBJECT: usize = 16_384;
const MAX_ARRAY: usize = 16_384;
const MAX_STRING: usize = 1024 * 1024;
struct Seed<'a> {
    nodes: &'a mut usize,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Value, D::Error> {
        if self.depth > MAX_DEPTH || *self.nodes >= MAX_NODES {
            return Err(de::Error::custom("bounded JSON limit"));
        }
        *self.nodes += 1;
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("bounded JSON number"))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        self.visit_string(value.to_owned())
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Value, E> {
        if value.len() > MAX_STRING {
            return Err(E::custom("bounded JSON string"));
        }
        Ok(Value::String(value))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(Seed {
            nodes: self.nodes,
            depth: self.depth + 1,
        })? {
            if values.len() >= MAX_ARRAY {
                return Err(de::Error::custom("bounded JSON array"));
            }
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if key.len() > MAX_STRING || values.len() >= MAX_OBJECT || values.contains_key(&key) {
                return Err(de::Error::custom("bounded JSON object"));
            }
            let value = map.next_value_seed(Seed {
                nodes: self.nodes,
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}
pub(super) fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let mut nodes = 0;
    let value = Seed {
        nodes: &mut nodes,
        depth: 0,
    }
    .deserialize(&mut decoder)
    .map_err(|_| Error::InvalidJson)?;
    decoder.end().map_err(|_| Error::InvalidJson)?;
    Ok(value)
}
