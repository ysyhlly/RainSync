export function validateAccount(
  username: string,
  password: string,
  displayName: string,
) {
  if (!username.trim())
    return { field: "username", message: "请填写登录账号。" };
  if (!password) return { field: "password", message: "请填写密码。" };
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(username))
    return {
      field: "username",
      message: "登录账号须为 1–80 个英文字母、数字、下划线、短横线或点",
    };
  if (!/^[\x20-\x7e]{8,1024}$/.test(password))
    return {
      field: "password",
      message: "密码须为 8–1024 个英文字符、数字、英文符号或空格，不支持中文",
    };
  const nickname = validateNickname(displayName);
  if (nickname) return { field: "display_name", message: nickname };
  return null;
}
export function validateNickname(value: string) {
  const trimmed = value.trim();
  if ([...trimmed].length > 50) return "昵称最多 50 个字符";
  if (/[\p{Cc}]/u.test(trimmed)) return "昵称不能含控制字符";
  return "";
}
