let driver: Promise<typeof import("./drivers/dash-driver")> | undefined;
/** Public code only. Resolving this module creates no SDK or media attachment. */
export function loadDashDriver() {
  if (!driver) {
    const pending = import("./drivers/dash-driver");
    driver = pending;
    void pending.catch(() => {
      if (driver === pending) driver = undefined;
    });
  }
  return driver;
}
