// Two narrated scenes on any dev server, with a sync probe between them that tests the tool itself.
export async function seed({ page }) {
  // A cold dev server compiles the settings route on its first visit, which would stall the click on camera.
  await page.goto(new URL("/settings/general", page.url()).href);
  await page.getByRole("heading", { name: "Working section" }).waitFor({ timeout: 60_000 });
  await page.goto(new URL("/", page.url()).href);
  await page.getByRole("navigation", { name: "Threads" }).waitFor();
}

export default {
  scenes: [
    {
      id: "open-settings",
      say: "Settings live at the bottom of the sidebar. One click opens them.",
      caption: "Open settings from the sidebar",
      ready: 'role=button[name="Settings"]',
      highlight: ['role=button[name="Settings"]'],
      steps: [{ action: "click", target: 'role=button[name="Settings"]' }],
      tailMs: 900,
    },
    {
      id: "sync-probe",
      probe: true,
      ready: 'role=heading[name="Working section"]',
      tailMs: 900,
    },
    {
      id: "working-section",
      key: true,
      say: "The Working section setting folds busy threads into one group. It is on by default.",
      caption: "Working section groups busy threads",
      ready: 'role=heading[name="Working section"]',
      highlight: ['role=heading[name="Working section"]'],
      tailMs: 1200,
    },
  ],
};
