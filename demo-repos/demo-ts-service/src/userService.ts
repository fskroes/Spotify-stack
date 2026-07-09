import { getJson } from "./legacy/httpClient.js";

export interface User {
  id: string;
  name: string;
}

/**
 * Look up a user by id from the users API.
 */
export function getUser(
  baseUrl: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<User> {
  return new Promise((resolve, reject) => {
    getJson<User>(
      `${baseUrl}/users/${id}`,
      (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data as User);
        }
      },
      fetchImpl,
    );
  });
}
