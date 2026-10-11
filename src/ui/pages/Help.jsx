import { T } from '../i18n.js';


export function Help() {
  return (
    <div class="card prose">
      <h2>{T('How it works', 'Hoe werkt het')}</h2>
      <ol>
        <li><b>{T('Listings live on Nostr.', 'Advertenties staan op Nostr.')}</b> {T('No company runs this marketplace. Your listings are signed with your key and stored on public relays; any copy of this app shows them.', 'Geen bedrijf runt deze marktplaats. Je advertenties zijn ondertekend met jouw sleutel en staan op openbare relays; elke kopie van deze app toont ze.')}</li>
        <li><b>{T('The buyer makes an offer', 'De koper doet een bod')}</b> {T('in XBT, picks an arbiter and sends the shipping address, all end-to-end encrypted.', 'in XBT, kiest een arbiter en stuurt het verzendadres, alles end-to-end versleuteld.')}</li>
        <li><b>{T('Both pay into escrow.', 'Beide betalen in escrow.')}</b> {T('The seller accepts, and the app shows one 2-of-3 multisig address with keys from buyer, seller and arbiter. The buyer pays price + deposit, the seller pays a deposit. Nobody, including the arbiter, can move the coins alone.', 'De verkoper accepteert en de app toont één 2-van-3 multisig-adres met sleutels van koper, verkoper en arbiter. De koper betaalt prijs + borg, de verkoper betaalt een borg. Niemand, ook de arbiter niet, kan de munten alleen verplaatsen.')}</li>
        <li><b>{T('The seller ships', 'De verkoper verstuurt')}</b> {T('with any carrier (PostNL, DHL, InPost, Mondial Relay, Packlink…) and adds the tracking code.', 'met elke vervoerder (PostNL, DHL, InPost, Mondial Relay, Packlink…) en voegt de track & trace toe.')}</li>
        <li><b>{T('The buyer releases.', 'De koper geeft vrij.')}</b> {T('Buyer and seller sign the payout together: the seller gets price + deposit, the buyer gets the deposit back.', 'Koper en verkoper tekenen samen de uitbetaling: de verkoper krijgt prijs + borg, de koper krijgt de borg terug.')}</li>
        <li><b>{T('If something goes wrong', 'Gaat er iets mis')}</b>, {T('either side opens a dispute. The arbiter reads the chat, asks for evidence and signs a split together with one of you. Because both sides have a deposit at stake, cheating costs money.', 'dan opent een van beide een geschil. De arbiter leest de chat, vraagt om bewijs en tekent samen met een van jullie een verdeling. Omdat beide partijen een borg hebben ingezet, kost valsspelen geld.')}</li>
      </ol>
      <h3>{T('Staying safe', 'Veilig handelen')}</h3>
      <ul>
        <li>{T('Back up your nsec. It is your account and it derives every escrow key.', 'Maak een back-up van je nsec. Het is je account en al je escrow-sleutels worden ervan afgeleid.')}</li>
        <li>{T('Pay into escrow from a wallet that signs with the BLAKE2b unified sighash (Bitcoin Knots, Sparrow BLAKE2b build, Shrike). Escrow payouts from this app always use it, so they cannot be replayed on the SHA256d chain.', 'Betaal in escrow vanuit een wallet die met de BLAKE2b unified sighash tekent (Bitcoin Knots, Sparrow BLAKE2b-build, Shrike). Uitbetalingen uit de escrow via deze app gebruiken die altijd, zodat ze niet op de SHA256d-chain herhaald kunnen worden.')}</li>
        <li>{T('Ship only after the escrow shows enough confirmations. The chain is young and its hashrate is small, so wait longer for larger amounts.', 'Verstuur pas als de escrow genoeg bevestigingen heeft. De chain is jong en de hashrate klein, dus wacht langer bij grotere bedragen.')}</li>
        <li>{T('Film packing and unpacking. Keep the conversation in the trade chat so the arbiter can see it.', 'Film het inpakken en uitpakken. Houd het gesprek in de trade-chat zodat de arbiter het kan zien.')}</li>
        <li>{T('Never accept an offer whose arbiter is not marked as approved.', 'Accepteer nooit een bod waarvan de arbiter niet als goedgekeurd is gemarkeerd.')}</li>
        <li>{T('New accounts have a trade limit that grows with verified trades.', 'Nieuwe accounts hebben een handelslimiet die groeit met geverifieerde trades.')}</li>
      </ul>
      <h3>{T('Fees', 'Kosten')}</h3>
      <p>{T('The app takes no fee. You pay the network fee of the payout transaction, shared in proportion to what each side receives. Arbiters state their own fee policy.', 'De app rekent geen kosten. Je betaalt de netwerkkosten van de uitbetaling, verdeeld naar verhouding van wat elke partij ontvangt. Arbiters vermelden zelf hun vergoeding.')}</p>
    </div>
  );
}
