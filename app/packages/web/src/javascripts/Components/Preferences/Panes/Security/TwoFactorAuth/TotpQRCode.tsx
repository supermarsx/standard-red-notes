import { QRCodeSVG } from 'qrcode.react'

export function TotpQRCode({ uri }: { uri: string }) {
  return (
    <div className="flex flex-shrink-0 flex-col items-center gap-2">
      <QRCodeSVG
        value={uri}
        size={180}
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
        title="Authenticator setup QR code"
        role="img"
        aria-label="Authenticator setup QR code"
      />
      <a href={uri} className="text-info text-sm underline">
        Open in authenticator app
      </a>
    </div>
  )
}
