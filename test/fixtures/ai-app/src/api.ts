// Written the way an AI assistant often writes it: plausible, but partly invented.
import axios from 'axios';
import { retryRequest } from 'axios-retry-pro'; // package does not exist on npm
import mime from 'mime-types'; // only installed because axios → form-data pulls it in

export async function getUser(id: string) {
  const res = await axios.fetch(`/users/${id}`); // axios has no .fetch()
  return retryRequest(() => res);
}

export const contentType = mime.lookup('report.json');
