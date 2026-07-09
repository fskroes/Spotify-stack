import { describe, expect, it } from "vitest";
import { getUser } from "../src/userService.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("getUser", () => {
  it("resolves with the user returned by the API", async () => {
    const user = await getUser(
      "https://api.example.test",
      "42",
      fakeFetch(200, { id: "42", name: "Ada" }),
    );
    expect(user).toEqual({ id: "42", name: "Ada" });
  });

  it("rejects when the API returns an error status", async () => {
    await expect(
      getUser("https://api.example.test", "nope", fakeFetch(500, {})),
    ).rejects.toThrow("HTTP 500");
  });
});
