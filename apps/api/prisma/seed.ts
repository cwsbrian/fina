async function main(): Promise<void> {
  console.log("Seed: nothing to do for Plan 1");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
