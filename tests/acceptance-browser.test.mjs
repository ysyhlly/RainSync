// Real Chromium observation smoke with self-generated canvas frames. This proves
// the driver lifecycle only, not RainSync sync, burned timecode or packet shaping.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createBrowserMeasurementDriver } from "../scripts/acceptance-browser.mjs";
import { collectCalibrations } from "../scripts/acceptance-network.mjs";
import { applyCalibration } from "../scripts/acceptance-measurements.mjs";

test(
  "real browser observer records independent presented-frame clocks and detects generation changes",
  { skip: !process.env.RAINSYNC_PLAYWRIGHT_MODULE, timeout: 30000 },
  async () => {
    const { chromium } = await import(
      pathToFileURL(process.env.RAINSYNC_PLAYWRIGHT_MODULE).href
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.RAINSYNC_BROWSER_EXECUTABLE,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    let driver;
    try {
      const clients = [];
      for (const client_id of ["left", "right"]) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(
          '<canvas width="320" height="180"></canvas><video muted></video>',
        );
        const source_url = await page.evaluate(async () => {
          const canvas = document.querySelector("canvas"),
            ctx = canvas.getContext("2d"),
            video = document.querySelector("video");
          let tick = 0;
          const paint = () => {
            ctx.fillStyle = tick++ % 2 ? "red" : "blue";
            ctx.fillRect(0, 0, 320, 180);
            requestAnimationFrame(paint);
          };
          paint();
          // srcObject has no source URL, so this fixture uses a named marker and
          // the same source-change check as a real srcObject adapter would need.
          const recorder = new MediaRecorder(canvas.captureStream(30), {
            mimeType: "video/webm;codecs=vp8",
          });
          const chunks = [];
          recorder.ondataavailable = (event) => chunks.push(event.data);
          const finished = new Promise((resolve) => {
            recorder.onstop = resolve;
          });
          recorder.start();
          await new Promise((resolve) => setTimeout(resolve, 600));
          recorder.stop();
          await finished;
          video.src = URL.createObjectURL(
            new Blob(chunks, { type: "video/webm" }),
          );
          video.loop = true;
          await video.play();
          return video.currentSrc;
        });
        clients.push({
          client_id,
          room: "r1",
          page,
          media_origin_ms: 0,
          source_url,
        });
      }
      driver = await createBrowserMeasurementDriver({
        clients,
        decodeTimecode: () => {
          throw Error("timecode verification not part of driver smoke");
        },
        saveFrame: () => {
          throw Error("not used");
        },
      });
      await clients[0].page.waitForTimeout(100);
      const identities = await driver.clients();
      const calibrations = await collectCalibrations(
        identities,
        (method, input) => driver[method](input),
      );
      const observation = await driver.sample();
      assert.equal(observation.clients.length, 2);
      for (const client of observation.clients) {
        assert.equal(client.unavailable, false, client.reason);
        assert.ok(
          client.presented_frames > 0 && client.playback_intervals.length > 0,
        );
        const aligned = applyCalibration(
          client,
          calibrations.get(client.client_id).calibration,
        );
        assert.ok(Number.isFinite(aligned.reference_offset_ms));
        assert.ok(aligned.clock_uncertainty_ms >= 0);
      }
      await clients[0].page.evaluate(() =>
        document
          .querySelector("video")
          .replaceWith(document.createElement("video")),
      );
      assert.equal((await driver.sample()).clients[0].unavailable, true);
    } finally {
      if (driver) await driver.dispose();
      await browser.close();
    }
  },
);
