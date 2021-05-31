import { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import Bot from '../../../Bot';

export default function accepted(offer: TradeOffer, bot: Bot): void {
    const custom = bot.options.customMessage.success;

    if (custom) {
        bot.sendMessage(offer.partner, custom);
    }
    bot.sendMessage(offer.partner, '/pre ✅ Success! The offer went through successfully.');
}
