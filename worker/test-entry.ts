export { RoomDurableObject } from "./room-durable-object.ts";

const testWorker = {
  fetch(): Response {
    return new Response("Workers integration test entrypoint");
  },
};

export default testWorker;
