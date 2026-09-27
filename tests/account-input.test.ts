import { expect, it } from "vitest";
import {
  validateAccount,
  validateNickname,
} from "../apps/web/src/features/auth/account-rules";
it("allows immutable account characters and printable passwords including eight spaces", () => {
  expect(validateAccount("a_B-1.test", "        ", "😀".repeat(50))).toBeNull();
  expect(validateAccount("a".repeat(80), " pass 12", "同名昵称")).toBeNull();
  expect(validateAccount("a".repeat(81), "12345678", "")?.field).toBe(
    "username",
  );
  expect(validateAccount("中文", "12345678", "")?.field).toBe("username");
  expect(validateAccount("ok", "1234567", "")?.field).toBe("password");
  expect(validateAccount("ok", "abc中文def", "")?.field).toBe("password");
  expect(validateAccount("ok", "12345678\n", "")?.field).toBe("password");
});
it("counts Unicode nickname scalars and allows an empty custom name", () => {
  expect(validateNickname("  ")).toBe("");
  expect(validateNickname("😀".repeat(50))).toBe("");
  expect(validateNickname("😀".repeat(51))).toContain("50");
  expect(validateNickname("a\u0000b")).toContain("控制");
});
