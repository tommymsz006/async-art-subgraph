import { Address, log, BigInt } from "@graphprotocol/graph-ts";
import { AsyncArtwork, RoyaltyAmountUpdated, Transfer as TransferEvent, BidProposed, BidWithdrawn, BuyPriceSet, TokenSale } from '../generated/AsyncArtwork/AsyncArtwork';
import { Market, Artwork, Account, Bid, Sale, Transfer } from '../generated/schema';

const BIRTH_ADDRESS: string = '0x0000000000000000000000000000000000000000';
const MARKET_ID: string = '0';
const INITIAL_PLATFORM_PRIMARY_FEE = 10;
const INITIAL_PLATFORM_SECONDARY_FEE = 1;
const INITIAL_ROYALTY_FEE = 4;

export function handleRoyaltyAmountUpdated(event: RoyaltyAmountUpdated): void {
  let market = Market.load(_loadMarket());
  market.platformPrimaryFee = event.params.platformFirstPercentage;
  market.platformSecondaryFee = event.params.platformSecondPercentage;
  market.artistRoyaltyFee = event.params.artistSecondPercentage;
  market.save();
}

export function handleTransfer(event: TransferEvent): void {
  let tokenIdStr = event.params.tokenId.toString();

  if (event.params.from.toHex() == BIRTH_ADDRESS) {
    let artwork = new Artwork(tokenIdStr);
    artwork.tokenId = event.params.tokenId;

    let artists = new Array<string>();
    let i: BigInt = BigInt.fromI32(0);
    let callResult = AsyncArtwork.bind(event.address).try_uniqueTokenCreators(event.params.tokenId, i);
    while(!callResult.reverted) {
      artists.push(_loadAccount(callResult.value));
      i = i + BigInt.fromI32(1);
      callResult = AsyncArtwork.bind(event.address).try_uniqueTokenCreators(event.params.tokenId, i);
    }
    artwork.artists = artists;

    artwork.owner = _loadAccount(event.params.to);
    artwork.uri = AsyncArtwork.bind(event.address).tokenURI(event.params.tokenId);
    artwork.isMaster = AsyncArtwork.bind(event.address).try_getControlToken(event.params.tokenId).reverted;  // master does not have control token
    artwork.bids = new Array<string>();
    artwork.sales = new Array<string>();
    artwork.transfers = new Array<string>();
    artwork.status = 'Created';
    artwork.timeCreated = event.block.timestamp;
    artwork.save();

    // handle master / layer
    let market = Market.load(_loadMarket());
    if (artwork.isMaster) {
      market.lastMasterArtwork = tokenIdStr;
      market.save();
    } else {
      artwork.masterArtwork = market.lastMasterArtwork;
    }

    log.debug("handleTransfer(): Artwork created - {}, {}, {}, {}", [tokenIdStr, artwork.owner, artwork.uri, artwork.timeCreated.toString()]);

  } else {
    let artwork = Artwork.load(tokenIdStr);
    if (artwork != null) {
      if (event.params.to.toHex() != BIRTH_ADDRESS) {
        let transfer = new Transfer(event.transaction.hash.toHex());
        transfer.from = _loadAccount(event.params.from);
        transfer.to = _loadAccount(event.params.to);
        transfer.timestamp = event.block.timestamp;
        transfer.save();

        let transfers = artwork.transfers;
        transfers.push(transfer.id);
        artwork.transfers = transfers;

        artwork.status = 'Sold';
        artwork.owner = _loadAccount(event.params.to);
        artwork.timeLastTransferred = transfer.timestamp;

        log.debug("handleTransfer(): Artwork tranferred - {}, {}, {}", [tokenIdStr, transfer.from, transfer.to]);
      } else {
        log.error("handleTransfer(): Artwork withdrawn - {}, {}", [tokenIdStr, event.block.timestamp.toString()]);
      }

      artwork.save();
    } else {
      log.error("_handleTransfer(): Artwork not found - {}", [tokenIdStr]);
    }
  }
}

export function handleBidProposed(event: BidProposed): void {
  let tokenIdStr = event.params.tokenId.toString();
  let artwork = Artwork.load(tokenIdStr);

  if (artwork != null) {
    let bid = new Bid(event.transaction.hash.toHex());
    bid.bidder = _loadAccount(event.params.bidder);
    bid.price = event.params.bidAmount;
    bid.timeRaised = event.block.timestamp;
    bid.status = 'Open';
    bid.save();

    let bids = artwork.bids;
    bids.push(bid.id);
    artwork.bids = bids;
    artwork.currentBid = bid.id;
    artwork.save();

    log.debug("handleBidProposed(): Bid proposed - {}, {}, {}", [tokenIdStr, bid.timeRaised.toString(), bid.bidder]);
  } else {
    log.error("handleBidProposed(): Artwork not found - {}", [tokenIdStr]);
  }
}

export function handleBidWithdrawn(event: BidWithdrawn): void {
  let tokenIdStr = event.params.tokenId.toString();
  let artwork = Artwork.load(tokenIdStr);

  if (artwork != null) {
    let bid = Bid.load(artwork.currentBid);
    if (bid != null) {
      bid.status = 'Cancelled';
      bid.timeCancelled = event.block.timestamp;
      bid.save();

      log.debug("handleBidWithdrawn(): Bid withdrawn: {}, {}", [bid.id, tokenIdStr]);
    } else {
      log.error("handleBidWithdrawn(): Withdrawn bid not found - {}, {}", [artwork.currentBid, tokenIdStr]);
    }
  } else {
    log.error("handleBidWithdrawn(): Artwork not found - {}", [tokenIdStr]);
  }
}

export function handleBuyPriceSet(event: BuyPriceSet): void {
  let tokenIdStr = event.params.tokenId.toString();
  let artwork = Artwork.load(tokenIdStr);

  if (artwork != null) {
    if (artwork.currentSale != null) {
      let sale = Sale.load(artwork.currentSale);
      if (sale != null) {
        sale.price = event.params.price;
        sale.save();
        log.debug("handleBuyPriceSet(): Set new sale price - {}, {}", [tokenIdStr, sale.price.toString()]);
      } else {
        log.error("handleBuyPriceSet(): Current sale not found - {}", [tokenIdStr]);
      }
    } else {
      let sale = new Sale(event.transaction.hash.toHex());
      sale.seller = artwork.owner;
      sale.price = event.params.price;
      sale.timeRaised = event.block.timestamp;
      sale.isSold = false;
      sale.save();

      let sales = artwork.sales;
      sales.push(sale.id);
      artwork.sales = sales;
      artwork.currentSale = sale.id;
      artwork.save();

      log.debug("handleBuyPriceSet(): On sale - {}, {}", [tokenIdStr, sale.price.toString()]);
    }
  } else {
    log.error("handleBuyPriceSet(): Artwork not found - {}", [tokenIdStr]);
  }
}

export function handleTokenSale(event: TokenSale): void {
  let tokenIdStr = event.params.tokenId.toString();
  let artwork = Artwork.load(tokenIdStr);

  if (artwork != null) {
    let bid = Bid.load(artwork.currentBid);
    if (bid != null && bid.price == event.params.salePrice && bid.bidder == event.params.buyer.toHex()) {
      bid.status = 'Accepted';
      bid.acceptedBy = artwork.owner;
      bid.timeAccepted = event.block.timestamp;
      bid.save();

      log.debug("handleTokenSale(): Bid accepted: {}, {}, {}", [bid.id, bid.acceptedBy, tokenIdStr]);
    } else {
      let sale = Sale.load(artwork.currentSale);
      if (sale != null) {
        sale.isSold = true;
        sale.buyer = _loadAccount(event.params.buyer);
        sale.timeSold = event.block.timestamp;
        sale.save();

        log.debug("handleTokenSale(): Bid accepted: {}, {}, {}", [bid.id, bid.acceptedBy, tokenIdStr]);
      } else {
        log.error("handleTokenSale(): Bid & sale not found - {}, {}, {}", [artwork.currentBid, artwork.currentSale, tokenIdStr]);
      }
    }
 
    let artists = artwork.artists;
    for (let i = 0; i < artists.length; i++) {
      // calculate artist's royalty and primary income, as well as artwork's first transfer price
      let artistAccount = Account.load(artists[i]);
      if (artistAccount != null) {
        let market = Market.load(_loadMarket());
        if (artwork.firstTransferPrice != null) {
          artistAccount.totalRoyalty = artistAccount.totalRoyalty + ((event.params.salePrice * market.artistRoyaltyFee / BigInt.fromI32(artwork.artists.length)) / BigInt.fromI32(100));
        } else {
          artistAccount.totalPrimaryIncome = artistAccount.totalPrimaryIncome + ((event.params.salePrice * (BigInt.fromI32(100) - market.platformPrimaryFee) / BigInt.fromI32(artwork.artists.length)) / BigInt.fromI32(100));
        }
        artistAccount.save();
      } else {
        log.error("handleTokenSale(): Artist not found - {}, {}", [artists[i], tokenIdStr]);
      }
    }

    artwork.currentBid = null;
    artwork.currentSale = null;
    if (artwork.firstTransferPrice == null) {
      artwork.firstTransferPrice = event.params.salePrice;
    }
    artwork.lastTransferPrice = event.params.salePrice;
    artwork.save();

    log.debug("handleTokenSale(): Artwork sold - {}, {}, {}", [tokenIdStr, event.params.buyer.toHex(), artwork.lastTransferPrice.toString()]);
  } else {
    log.error("handleTokenSale(): Artwork not found - {}", [tokenIdStr]);
  }
}

function _loadAccount(address: Address): string {
  let accountId = address.toHex();
  let account = Account.load(accountId);

  if (account == null) {
    account = new Account(accountId);
    account.address = address;
    account.totalPrimaryIncome = BigInt.fromI32(0);
    account.totalRoyalty = BigInt.fromI32(0);
    account.save();
  }

  return accountId;
}

function _loadMarket(): string {
  let market = Market.load(MARKET_ID);

  if (market == null) {
    market = new Market(MARKET_ID);
    market.platformPrimaryFee = BigInt.fromI32(INITIAL_PLATFORM_PRIMARY_FEE);
    market.platformSecondaryFee = BigInt.fromI32(INITIAL_PLATFORM_SECONDARY_FEE);
    market.artistRoyaltyFee = BigInt.fromI32(INITIAL_ROYALTY_FEE);
    market.save();
  }

  return MARKET_ID;
}