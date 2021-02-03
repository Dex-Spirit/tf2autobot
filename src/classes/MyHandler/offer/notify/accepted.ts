import { TradeOffer } from 'steam-tradeoffer-manager';
import Bot from '../../../Bot';

export default function accepted(offer: TradeOffer, bot: Bot): void {
    if (bot.options.customMessage.success) {
        bot.sendMessage(offer.partner, bot.options.customMessage.success);
        bot.sendMessage(offer.partner, '/pre ✅ Success! The offer went through successfully.');
    } else {
        bot.sendMessage(offer.partner, '/pre ✅ Success! The offer went through successfully.');
    }
}
