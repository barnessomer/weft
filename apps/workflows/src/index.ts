export default {
  fetch(): Response {
    return new Response("@weft/workflows scaffold");
  }
} satisfies ExportedHandler;
