exports.default = async function (configuration) {
  // Unsigned build (local / public CI): no DigiCert KeyLocker credentials, so
  // skip signing entirely instead of invoking smctl with an empty keypair.
  if (!process.env.SM_KEYPAIR_ALIAS) {
    return
  }
  if (configuration.path) {
    const keypairAlias = process.env.SM_KEYPAIR_ALIAS

    require('child_process').execSync(
      `smctl sign --keypair-alias="${keypairAlias}" --input "${String(configuration.path)}" --verbose`,
      {
        stdio: 'inherit',
      },
    )
  }
}
