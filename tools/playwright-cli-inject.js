async () => {
  // Dead end: playwright-cli `run-code --filename` runs inside the already
  // started CLI daemon. MGK_PERSONA / MGK_ROOT from the invoking shell never
  // reach process.env here. Use tools/persona-inject.sh maker|taker instead
  // (it interpolates the installer path into the snippet).
  throw new Error(
    "Do not use playwright-cli-inject.js. Run tools/persona-inject.sh maker|taker, then playwright-cli -s=<persona> reload.",
  );
}
