import { T } from '../i18n.js';


export function Help() {
  return (
    <div class="card prose">
      <h2>{T('How it works', 'Cómo funciona')}</h2>
      <ol>
        <li><b>{T('Listings live on Nostr.', 'Los anuncios están en Nostr.')}</b> {T('No company runs this marketplace. Your listings are signed with your key and stored on public relays; any copy of this app shows them.', 'Ninguna empresa gestiona este mercado. Tus anuncios van firmados con tu clave y se guardan en relays públicos; cualquier copia de esta app los muestra.')}</li>
        <li><b>{T('Chat first, then order.', 'Primero chatea, luego pide.')}</b> {T('Ask the seller anything without obligation. When ready, order from the chat: payment method (Lightning, on-chain or escrow), your price in XBT and the delivery. All end-to-end encrypted.', 'Pregunta al vendedor lo que quieras sin compromiso. Cuando quieras, pide desde el chat: método de pago (Lightning, on-chain o escrow), tu precio en XBT y la entrega. Todo cifrado de extremo a extremo.')}</li>
        <li><b>{T('The seller accepts, then you send the details.', 'El vendedor acepta y luego envías los datos.')}</b> {T('Only now: your address, and with escrow an approved arbiter and a refund address. With Lightning you pay the payment request in the chat with one tap.', 'Solo ahora: tu dirección y, con escrow, un árbitro aprobado y una dirección de reembolso. Con Lightning pagas la solicitud de pago del chat con un toque.')}</li>
        <li><b>{T('With escrow, both pay into it.', 'Con escrow, ambos pagan al escrow.')}</b> {T('The app shows one 2-of-3 multisig address with keys from buyer, seller and arbiter. The buyer pays price + deposit, the seller pays a deposit. Nobody, including the arbiter, can move the coins alone.', 'La app muestra una dirección multisig 2 de 3 con claves del comprador, el vendedor y el árbitro. El comprador paga precio + depósito y el vendedor un depósito. Nadie, ni siquiera el árbitro, puede mover las monedas por su cuenta.')}</li>
        <li><b>{T('The seller ships', 'El vendedor envía')}</b> {T('with one of the carriers you picked; you paid its rate with the order. Where available the seller gets a prepaid label with a QR code in the chat, and you get the tracking link.', 'con uno de los transportistas que elegiste; pagaste su tarifa con el pedido. Donde se puede, el vendedor recibe una etiqueta prepagada con código QR en el chat, y tú el enlace de seguimiento.')}</li>
        <li><b>{T('The buyer releases.', 'El comprador libera el pago.')}</b> {T('Buyer and seller sign the payout together: the seller gets price + deposit, the buyer gets the deposit back.', 'Comprador y vendedor firman juntos el pago: el vendedor recibe precio + depósito y el comprador recupera su depósito.')}</li>
        <li><b>{T('If something goes wrong', 'Si algo sale mal')}</b>, {T('either side opens a dispute. The arbiter reads the chat, asks for evidence and signs a split together with one of you. Because both sides have a deposit at stake, cheating costs money.', 'cualquiera de las partes abre una disputa. El árbitro lee el chat, pide pruebas y firma un reparto junto con uno de vosotros. Como ambas partes tienen un depósito en juego, hacer trampa cuesta dinero.')}</li>
      </ol>
      <h3>{T('Staying safe', 'Cómo protegerte')}</h3>
      <ul>
        <li>{T('Back up your nsec. It is your account and it derives every escrow key.', 'Guarda una copia de tu nsec. Es tu cuenta y de ella se derivan todas tus claves de escrow.')}</li>
        <li>{T('Pay into escrow from a wallet that signs with the BLAKE2b unified sighash (Bitcoin Knots, Sparrow BLAKE2b build, Shrike). Escrow payouts from this app always use it, so they cannot be replayed on the SHA256d chain.', 'Paga al escrow desde una cartera que firme con el sighash unificado de BLAKE2b (Bitcoin Knots, la versión BLAKE2b de Sparrow, Shrike). Los pagos del escrow desde esta app siempre lo usan, así que no se pueden reproducir en la cadena SHA256d.')}</li>
        <li>{T('Ship only after the escrow shows enough confirmations. The chain is young and its hashrate is small, so wait longer for larger amounts.', 'Envía solo cuando el escrow tenga suficientes confirmaciones. La cadena es joven y su hashrate es bajo, así que espera más para importes grandes.')}</li>
        <li>{T('Film packing and unpacking. Keep the conversation in the trade chat so the arbiter can see it.', 'Graba el empaquetado y el desempaquetado. Mantén la conversación en el chat de la compra para que el árbitro pueda verla.')}</li>
        <li>{T('Never accept an offer whose arbiter is not marked as approved.', 'No aceptes nunca un pedido cuyo árbitro no esté marcado como aprobado.')}</li>
        <li>{T('New accounts have a trade limit that grows with verified trades.', 'Las cuentas nuevas tienen un límite de compra que crece con las compras verificadas.')}</li>
      </ul>
      <h3>{T('Testing', 'Pruebas')}</h3>
      <p><a href="./testplan.html" target="_blank" rel="noopener">{T('Open the test plan', 'Abre el plan de pruebas')}</a> {T('to check everything works, step by step.', 'para comprobar paso a paso que todo funciona.')}</p>
      <h3>{T('Fees', 'Comisiones')}</h3>
      <p>{T('The app takes no fee. You pay the network fee of the payout transaction, shared in proportion to what each side receives. Arbiters state their own fee policy.', 'La app no cobra comisión. Pagas la comisión de red de la transacción de pago, repartida en proporción a lo que recibe cada parte. Los árbitros indican su propia comisión.')}</p>
    </div>
  );
}
