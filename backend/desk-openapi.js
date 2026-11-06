export function deskOpenApi() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Valhalla desk",
      version: "35.0.0",
      description: "Read-only and paper routes. Live trading is not available. Your provider, your quota.",
    },
    paths: {
      "/api/apps/trading/capabilities": {
        get: { summary: "Paper and view only. liveTrading is false." },
      },
      "/api/apps/thalos/analysis": {
        post: { summary: "Paper summary of numbers you send. No order is placed." },
      },
      "/api/apps/data-explorer/inspect": {
        post: { summary: "Counts fields in JSON you send. No remote fetch." },
      },
    },
    "x-valhalla": {
      liveTrading: false,
      paper: true,
      signTransaction: false,
      unlimited: false,
      expertTools: "not-configured",
    },
  };
}
