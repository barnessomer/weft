export default {
  fetch(): Response {
    return new Response("@weft/sandbox scaffold");
  }
} satisfies ExportedHandler;
