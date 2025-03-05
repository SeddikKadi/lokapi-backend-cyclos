import { t } from '@lokavaluto/lokapi'
import Account from '@lokavaluto/lokapi/build/backend/odoo/account'

import { CyclosRecipient } from './recipient'


export class CyclosAccount extends Account implements t.IAccount {

    creditable = true

    async getBalance () {
        return this.jsonData.cyclos.status.balance
    }

    public async isBusinessAccountForFinancialBackend () {
        return (this.jsonData.cyclos.type.internalName === 'comptePro' )
    }
    
    async getSymbol () {
        return this.jsonData.cyclos.currency.symbol
    }

    get internalId () {
        return `${this.parent.internalId}/${this.jsonData.cyclos.id}`
    }

    public async transfer (
        recipient: CyclosRecipient,
        amount: number,
        senderMemo: string,
        recipientMemo: string
    ) {
        // On cyclos, account transfer is managed through the owner account
        return recipient.transfer(amount, senderMemo, recipientMemo)
    }


    /**
     * get URL to Credit given amount on current account
     *
     * @throws {RequestFailed, APIRequestFailed, InvalidCredentials, InvalidJson}
     *
     * @returns Object
     */
    public async getCreditUrl (amount: number): Promise<string> {
        if (amount > 2**46 - 1) {
            throw new Error('Amount is exceeding limits for safe representation')
        }
        return this.backends.odoo.$post('/cyclos/credit', {
            owner_id: this.parent.ownerId,
            amount,
        })
    }

}
