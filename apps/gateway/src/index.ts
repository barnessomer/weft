export default {
  fetch(): Response {
    return new Response("@weft/gateway scaffold");
  }
} satisfies ExportedHandler;
