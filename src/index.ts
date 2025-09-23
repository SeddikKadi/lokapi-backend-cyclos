import { e as HttpRequestExc } from '@0k/types-request'

import { JsonRESTPersistentClientAbstract } from '@lokavaluto/lokapi/build/rest'
import { t, RestExc } from '@lokavaluto/lokapi'
import { mux } from '@lokavaluto/lokapi/build/generator'
import { BackendAbstract } from '@lokavaluto/lokapi/build/backend'
import UserAccount from '@lokavaluto/lokapi/build/backend/odoo/userAccount'

import { CyclosAccount } from './account'
import { CyclosRecipient } from './recipient'
import { CyclosTransaction, getRelatedId } from './transaction'

import { CyclosCreditRequest } from "./creditRequest"

interface IJsonDataWithOwner extends t.JsonData {
    owner_id: string
}


export default abstract class CyclosBackendAbstract extends BackendAbstract {

    splitMemoSupport = false

    _cyclosBackends: { [index: string]: any } = {}

    getCyclosBackend (url: any, token: any) {
        if (!this._cyclosBackends[url]) {
            const { httpRequest, base64Encode, persistentStore, requestLogin } = this
            class Cyclos extends JsonRESTPersistentClientAbstract {
                AUTH_HEADER = 'Session-token'

                httpRequest = httpRequest
                base64Encode = base64Encode
                persistentStore = persistentStore
                requestLogin = requestLogin

                constructor(url, token) {
                    super(url)
                    this.lazySetApiToken(token)
                }

                get internalId () {
                    let port
                    if ((this.port == 80 && this.protocol == 'http') ||
                        (this.port == 443 && this.protocol == 'https')) {
                        port = ""
                    } else {
                        port = `:${this.port}`
                    }
                    return `${this.host}${port}`
                }

                public async request (path: string, opts: t.HttpOpts): Promise<any> {
                    let response: any
                    try {
                        response = await super.request(path, opts)
                    } catch (err) {
                        if (err instanceof HttpRequestExc.HttpError && err.code === 401) {
                            let errCode: string
                            try {
                                const data = JSON.parse(err.data)
                                errCode = data.code
                            } catch (err2) {
                                console.log(
                                    'Could not get error code from JSON request body',
                                    err2
                                )
                                throw err
                            }
                            if (errCode === 'loggedOut') {
                                console.log('Cyclos Authentication Required')
                                throw new RestExc.AuthenticationRequired(
                                    err.code,
                                    'Authentication Failed',
                                    err.data,
                                    err.response
                                )
                            }
                        }
                        throw err
                    }
                    return response
                }

            }
            this._cyclosBackends[url] = new Cyclos(url, token)
        }
        return this._cyclosBackends[url]
    }

    async isUnconfigured() {
        const accounts = await this.getAccounts()
        return (false && accounts.length === 0)
    }

    
    private getSubBackend (jsonData: IJsonDataWithOwner) {
        const { httpRequest, base64Encode, persistentStore, requestLogin } =
            this
        return new CyclosUserAccount(
            {
                cyclos: this.getCyclosBackend(jsonData.url, jsonData.token),
                ...this.backends
            },
            this,
            jsonData
        )
    }

    public get userAccounts () {
        if (!this._userAccounts) {
            this._userAccounts = {}
            this.jsonData.accounts.forEach(
                (userAccountData: IJsonDataWithOwner) => {
                    const cyclosUserAccount =
                        this.getSubBackend(userAccountData)
                    this._userAccounts[cyclosUserAccount.internalId] =
                        cyclosUserAccount
                }
            )
        }
        return this._userAccounts
    }

    private _userAccounts: any


    public async getAccounts (): Promise<any> {
        const backendBankAccounts = []
        for (const id in this.userAccounts) {
            const userAccount = this.userAccounts[id]
            const bankAccounts = await userAccount.getAccounts()
            bankAccounts.forEach((bankAccount: any) => {
                backendBankAccounts.push(bankAccount)
            })
        }
        return backendBankAccounts
    }


    public makeRecipients (jsonData: t.JsonData): t.IRecipient[] {
        const recipients = []
        if (Object.keys(this.userAccounts).length === 0) {
            throw new Error(
                'Current user has no account in cyclos. Unsupported yet.'
            )
        }
        if (Object.keys(this.userAccounts).length > 1) {
            // We will need to select one of the source userAccount of the
            // current logged in user
            throw new Error(
                'Current user has more than one account in cyclos. ' +
                    'Unsupported yet.'
            )
        }
        jsonData.monujo_backends[this.internalId].forEach((ownerId: string) => {
            // Each ownerId here is a different account in cyclos for recipient
            recipients.push(
                new CyclosRecipient(
                    {
                        cyclos: Object.values(this.userAccounts)[0],
                        ...this.backends,
                    },
                    this,
                    {
                        odoo: jsonData,
                        cyclos: { owner_id: ownerId },
                    }
                )
            )
        })
        return recipients
    }

    public async * getTransactions (opts: any): AsyncGenerator {
        yield * CyclosTransaction.mux(
            Object.values(this.userAccounts).map(
                (u: CyclosUserAccount) => u.getTransactions(opts)
            ),
            opts?.order || ['-date']
        )
    }

}


class CyclosUserAccount extends UserAccount {

    ownerId: string

    constructor (backends, parent, jsonData) {
        super(backends, parent, jsonData)
        this.ownerId = jsonData.owner_id
    }

    public get active () {
        return this.jsonData.active
    }

    get internalId () {
        return `cyclos:${this.ownerId}@${this.backends.cyclos.internalId}`
    }

    _accounts: Array<CyclosAccount> | null = null
    _accountsPromise: Promise<Array<CyclosAccount>> | null = null
    async getAccounts () {
        if (!this._accounts) {
            if (!this._accountsPromise) {
                const self = this
                let _accountsPromise: Promise<any>
                _accountsPromise = (async () => {
                    if (!self.active) return []

                    const jsonAccounts = await self.backends.cyclos.$get(
                        `/${self.ownerId}/accounts`
                    )
                    const accounts = []
                    jsonAccounts.forEach((jsonAccountData: any) => {
                        accounts.push(
                            new CyclosAccount(
                                { cyclos: self, ...self.backends },
                                self,
                                {
                                    cyclos: jsonAccountData,
                                }
                            )
                        )
                    })
                    self._accounts = accounts
                })()
                this._accountsPromise = _accountsPromise
            }
            try {
                await this._accountsPromise
            } catch (err) {
                this._accountsPromise = null
                this._accounts = null
                throw err
            }
        }
        return this._accounts
    }

    async getSymbol () {
        let bankAccounts = await this.getAccounts()

        if (Object.keys(bankAccounts).length === 0) {
            throw new Error(
                'Current user account has no bank accounts in cyclos. Unsupported yet.'
            )
        }
        if (Object.keys(bankAccounts).length > 1) {
            // We will need to select one of the source userAccount of the
            // current logged in user
            throw new Error(
                'Current user account has more than one bank account in cyclos. ' +
                    'Unsupported yet.'
            )
        }
        return await bankAccounts[0].getSymbol()
    }


    public async requiresUnlock () {
        return false
    }

    public async * getTransactions (opts: any): AsyncGenerator {
        if (!this.active) return
        const order = opts?.order || ['-date']
        if (order.length > 1) {
            throw new Error('Multiple order keys not supported yet.')
        }
        let orderStr = order[0]
        let direction = 'Asc'
        if (orderStr.startsWith('-')) {
            orderStr = orderStr.substring(1)
            direction = 'Desc'
        } else if (orderStr.startsWith('+')) {
            orderStr = orderStr.substring(1)
        }
        if (!['date', 'amount'].includes(orderStr)) {
            throw new Error(
                `Invalid sort key '${orderStr}'. ` +
                    "Only value supported is 'date' or 'amount'."
            )
        }

        const orderBy = `${orderStr}${direction}`
        let datePeriod = null
        switch (
            [opts?.dateBegin, opts?.dateEnd]
                .map((x) => (x ? '1' : '0'))
                .join('')
        ) {
            case '10':
                datePeriod = [opts.dateBegin.toISOString()]
                break
            case '01':
                datePeriod = [',' + opts.dateEnd.toISOString()]
                break
            case '11':
                datePeriod = [opts.dateBegin, opts.dateEnd]
                    .map((d) => d.toISOString())
                    .join(',')
                break
        }
        let responseHeaders: { [k: string]: string }
        let page = 0
        let transactionsData: any
        const backend = this.parent
        const addressResolve = {}
        const reconversionStatusResolve = {}
        const symbol = await this.getSymbol()
        while (true) {
            responseHeaders = {}
            transactionsData = await this.backends.cyclos.$get(
                `/${this.ownerId}/transactions`,
                {
                    page,
                    orderBy,
                    ...(datePeriod && { datePeriod }),
                },
                {},
                responseHeaders
            )
            const uniqueAddresses = transactionsData
                .map(getRelatedId)
                .filter(
                    (t: any, idx: number, self) =>
                        self.indexOf(t) === idx &&
                        typeof addressResolve[t] === 'undefined' &&
                        t !== 'Admin' && t !== null
                )
            if (uniqueAddresses.length > 0) {
                const contacts = await this.backends.odoo.$post(
                    '/cyclos/contact',
                    {
                        addresses: uniqueAddresses,
                    }
                )
                for (const k in contacts) {
                    addressResolve[k] = contacts[k]
                }
            }
            // XXXvlab: will need to change all internalId's to match new
            // format
            const backendInternalId = backend.internalId.replace(":", "://")

            const uniqueReconversionAddresses = transactionsData
                .filter((txData: any) => (getRelatedId(txData) === 'Admin' && txData.amount <= 0))
                .map((txData:any) => `${backendInternalId}/tx/${txData.id}`)
                .filter((txId: any, idx, self) => self.indexOf(txId) === idx &&
                    typeof reconversionStatusResolve[txId] === 'undefined')

            if (uniqueReconversionAddresses.length > 0) {
                const reconversions = await this.backends.odoo.$post(
                    '/partner/reconversions',
                    {
                        transactions: uniqueReconversionAddresses,
                    })
                for (const t in reconversions) {
                    reconversionStatusResolve[t] = reconversions[t]
                }
            }

            for (let idx = 0; idx < transactionsData.length; idx++) {
                yield new CyclosTransaction(
                    this.backends,
                    this,
                    {
                        cyclos: { symbol, ...transactionsData[idx] },
                        odoo: { addressResolve, reconversionStatusResolve },
                    }
                )
            }
            if (responseHeaders['x-has-next-page'] === 'false') {
                return
            }
            page++
        }
    }

    public async isBusinessForFinanceBackend () {
        console.warn("Cyclos User group info not implemented yet")
        return false
    }

    public async makeCreditRequest(
        jsonData: t.JsonData
    ): Promise<t.ICreditRequest> {
        const symbol = await this.getSymbol()
        return new CyclosCreditRequest(
            {
                ...this.backends,
            },
            this,
            {
                odoo: jsonData,
                cyclos: { symbol },
            }
        )
    }
}
