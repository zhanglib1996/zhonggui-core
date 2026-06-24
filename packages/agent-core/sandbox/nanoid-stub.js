export function nanoid(size) {
  size = size || 21;
  var id = "";
  for (var i = 0; i < size; i++) id += "0123456789abcdef"[Math.random() * 16 | 0];
  return id;
}
export default nanoid;
