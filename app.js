var fs = require('fs');
var axios = require('axios');
var Promise = require("bluebird");

/**
 * w0utje's edit of Hawky's LPoSDistributor
 * added mercury and ripto bux fee calculation
 * added (cancelled) leases infomation to be re-used next payout 
 * added HTML payout overview generation
 * added feeAssetId to the payments for sending payments with a custom assetFee
 * Removed 0.003 Waves Fee substraction, because of the custom assetFee adding
 * if you don't want to use an assetFee, remember that you'll need to substract the waves fee for each transaction.   
 * 
 *    Planned MRT distribution, ToDo
 * 		425419 - 475418 -> 50 MRT / block
 *		475419 - 525418 -> 40 MRT / block
 *		525419 - 575418 -> 30 MRT / block
 *		575419 - 625418 -> 20 MRT / block
 *		625419 - 925418 -> 10 MRT / block  
 *    
 * Put your settings here:
 *     - address: the address of your node that you want to distribute from
 *     - startBlockHeight: the block from which you want to start distribution for
 *     - endBlock: the block until you want to distribute the earnings
 *     - distributableMRTPerBlock: amount of MRT distributed per forged block
 *     - filename: file to which the payments for the mass payment tool are written
 *     - paymentid: used to create payment and html file with this id.   
 *     - node: address of your node in the form http://<ip>:<port
 *     - percentageOfFeesToDistribute: the percentage of Waves fees that you want to distribute
 */
var config = {
    address: '',
    startBlockHeight: 559474,
    endBlock: 567751,
    startBlock: 462000,
    distributableMrtPerBlock: 30,
    filename: 'payment', //.json added automatically
    paymentid: 11,
    //node: 'http://127.0.0.1:6869',
    node: 'http://nodes.wavesnodes.com',
    percentageOfFeesToDistribute: 100,
    interval: 100,
};
 

var myLeases = {};
var myCanceledLeases = {};

var currentStartBlock = 462000;


var fs=require('fs');
var prevleaseinfofile = config.startBlockHeight + "_" + config.address + ".json";
if (fs.existsSync(prevleaseinfofile)) 
{
	console.log("reading" + prevleaseinfofile + " file");
	var data=fs.readFileSync(prevleaseinfofile);
  if (!data) {
    throw Error("DO NOT EXIST prevleaseinfofile. plz check your file.");
  }
  try {
    var prevleaseinfo= JSON.parse(data);
  } catch (e) {
    throw Error("JSON parse error. check your data.", data);
  }
	myLeases = prevleaseinfo["leases"];
	myCanceledLeases = prevleaseinfo["canceledleases"];
	currentStartBlock = config.startBlockHeight;
}


var payments = [];
var mrt = [];
var merfees=[];
var rbxfees=[];

var assetfees = [];
var allfees = [assetfees];
var BlockCount = 0;

var LastBlock = {};

var myForgedBlocks = [];

/**
  * This method starts the overall process by first downloading the blocks,
  * preparing the necessary datastructures and finally preparing the payments
  * and serializing them into a file that could be used as input for the
  * masspayment tool.
 */
var start = function() {
    console.log('getting blocks...');
    getAllBlocks().then(function(blocks) {
      console.log('preparing datastructures...');
      prepareDataStructure(blocks);
      console.log('preparing payments...');
      myForgedBlocks.forEach(function(block) {
          if (block.height >= config.startBlockHeight && block.height <= config.endBlock) {
              var blockLeaseData = getActiveLeasesAtBlock(block);
              var activeLeasesForBlock = blockLeaseData.activeLeases;
              var amountTotalLeased = blockLeaseData.totalLeased;

              distribute(activeLeasesForBlock, amountTotalLeased, block);
              BlockCount++;
          }
      });
      //Get last block
      LastBlock = blocks.slice(-1)[0] ;  
      pay();
      console.log("blocks forged: " + BlockCount);
    });
  
};

/**
 * This method organizes the datastructures that are later on necessary
 * for the block-exact analysis of the leases.
 *
 *   @param blocks all blocks that should be considered
 */
 
var prepareDataStructure = function(blocks) {
    blocks.forEach(function(block) {
        var wavesFees = 0;
        var merFees = 0;
        var rbxFees = 0;
        var assetFees = [];

        if (block.generator === config.address) {
            myForgedBlocks.push(block);
        }

        block.transactions.forEach(function(transaction) {
            // type 8 are leasing tx
            if (transaction.type === 8 && transaction.recipient === config.address) {
                transaction.block = block.height;
                myLeases[transaction.id] = transaction;
            } else if (transaction.type === 9 && myLeases[transaction.leaseId]) { // checking for lease cancel tx
                transaction.block = block.height;
                myCanceledLeases[transaction.leaseId] = transaction;
            }
            // considering Waves fees
            if (!transaction.feeAsset || transaction.feeAsset === '' || transaction.feeAsset === null) {
            	if(transaction.fee < 200000000) // if tx waves fee is more dan 2 waves, filter it. probably a mistake by someone
            	{
                	wavesFees += transaction.fee;
                } else {
			console.log("Filter TX at block: " + block.height + " Amount: " +  transaction.fee)
		}
            } else {
						// assetfee dynamic	testing
						  assetFees = InsertOrUpdateArray(assetFees,transaction.feeAsset,transaction.fee);  //test for combined assetsfees array
						}
            

            if (transaction.feeAsset === 'HzfaJp8YQWLvQG4FkUxq2Q7iYWMYQ2k8UF89vVJAjWPj') {     //Mercury
                merFees += transaction.fee;
            }       
            if (transaction.feeAsset === 'AnERqFRffNVrCbviXbDEdzrU6ipXCP5Y1PKpFdRnyQAy') {     //Ripto Bux
                rbxFees += transaction.fee;
            }                      
            
            
        });
        block.wavesFees = wavesFees;
        block.merFees = merFees;
        block.rbxFees = rbxFees;
        block.assetFees = assetFees;
    });
};

var makeBlockNumberArray = function(startBlock) {
  var interval = config.interval || 100;
  var endBlock = config.endBlock || 567751;  
  var currentStartBlock = startBlock || 0;
  var blockNumberArray;
  
  while (currentStartBlock <= endBlock) {
      blockNumberArray.push(currentStartBlock);
      currentStartBlock = startBlock + interval - 1;
  }
  if (blockNumberArray[blockNumberArray.length - 1] !== endBlock) {
    blockNumberArray.push(endBlock);
  }
  return blockNumberArray;
}

/**
 * Method that returns all relevant blocks.
 *
 * @returns {Array} all relevant blocks
 */

var getAllBlocks = function() {
  var blockNumberArray = makeBlockNumberArray(config.startBlock);
  var interval = config.interval;
  return Promise.reduce(blockIntervalArray, function(allBlocks, currentblock, index, length) {
    if (index + 1 === length) {
      return allBlocks;
    }
    var upperBlock = blockIntervalArray[index + 1];
    var wavesNodeUrl = config.node + '/blocks/seq/' + currentblock + '/' + upperBlock;
    console.log('getting blocks from ' + wavesNodeUrl);      
    return axios({
      method: 'get',
      url: wavesNodeUrl,
      headers: {
        'Connection': 'keep-alive'
      }
    })
    .then(function(response) {
      console.log("response::" + response);
      var currentBlocks = response;
      if (Array.isArray(currentBlocks)) {
        currentBlocks.forEach(function(block) {
            if (block.height <= endBlock) {
              allBlocks.push(block);
              return allBlocks;
            }
        });
      } else {
        throw new Error("block data is not array.", currentBlocks);
      }
    })
    .catch(error) {
      console.log(error);
    };
  }, config.startBlock);
}


/**
 * This method distributes either Waves fees and MRT to the active leasers for
 * the given block.
 *
 * @param activeLeases active leases for the block in question
 * @param amountTotalLeased total amount of leased waves in this particular block
 * @param block the block to consider
 */
var distribute = function(activeLeases, amountTotalLeased, block) {
    var fee = block.wavesFees;
    var merfee = block.merFees;
    var rbxfee = block.rbxFees;
    var assetFees = block.assetFees;

    for (var address in activeLeases) {
        var share = (activeLeases[address] / amountTotalLeased)
        var amount = fee * share;
        var meramount = merfee * share;
        var rbxamount = rbxfee * share;
        
        var assetamounts = [];
        for(var i in assetFees)
        {
		assetamounts[i]=assetFees[i] * share;
	}
        
        var amountMRT = share * config.distributableMrtPerBlock;

        if (address in payments) {
            payments[address] += amount * (config.percentageOfFeesToDistribute / 100);
            mrt[address] += amountMRT;
            merfees[address] +=  meramount * (config.percentageOfFeesToDistribute / 100);
            rbxfees[address] +=  rbxamount * (config.percentageOfFeesToDistribute / 100);
            
            allfees[address]=assetamounts; //toch 100%    hier loop door assets
            
        } else {
            payments[address] = amount * (config.percentageOfFeesToDistribute / 100);
            mrt[address] = amountMRT;
            merfees[address] =  meramount * (config.percentageOfFeesToDistribute / 100);
            rbxfees[address] =  rbxamount * (config.percentageOfFeesToDistribute / 100);
            
            allfees[address]=assetamounts; //toch 100%
        }

        console.log(address + ' will receive ' + amount + ' of(' + fee + ') and Mer amount: ' + meramount + ' (' + merfee + ') and ' + amountMRT + ' MRT for block: ' + block.height + ' share: ' + share);
    }
};

/**
 * Method that creates the concrete payment tx and writes it to the file
 * configured in the config section.
 */
var pay = function() {
    var transactions = [];
    var totalMRT = 0;
    var totalfees =0;
    var totalmerfees=0;
    var totalrbxfees=0;
    
    var totalassetsfees=[];
    
    var html = "";
    
    var html = "<!DOCTYPE html>" +
"<html lang=\"en\">" +
"<head>" +
"  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" + 
"  <link rel=\"stylesheet\" href=\"https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css\">" +
"  <script src=\"https://ajax.googleapis.com/ajax/libs/jquery/3.2.1/jquery.min.js\"></script>" +
"  <script src=\"https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/js/bootstrap.min.js\"></script>" +
"</head>" +
"<body>" +

"<div class=\"container\">" +
"  <h3>Fee's between blocks " + config.startBlockHeight + " - " + config.endBlock + ", Payout #" + config.paymentid + "</h3>" +
"  <h4>(LPOS address: " + config.address + ")</h4>" +
"  <h5>29-06-2017: Hi all, again a short update of the fee's earned by the bearwaves node. Automated distribution, riding on BearWaves $BEAR. Cheers!</h5> " +
"  <h5>You can always contact us by <a href=\"mailto:bearwaves@outlook.com\">E-mail</a> or in Waves Slack @w0utje <img src=\"https://www.bearwaves.nl/wp-content/uploads/2017/08/banksy.jpg\" style=\"width:50px;height:50px;\"></h5>" +
"  <h5>Blocks forged: " + BlockCount + "</h5>" + 
"  <table class=\"table table-striped table-hover\">" +
"    <thead> " +
"      <tr>" +
"        <th>Address</th>" +
"        <th>Waves</th>" +
"        <th>MRT</th>" +
"        <th>Mercury</th>" +
"        <th>Ripto Bux</th>" +        
        
"      </tr>" +
"    </thead>" +
"    <tbody>";
    
    for (var address in payments) {
        var payment = (payments[address] / Math.pow(10, 8));
        console.log(address + ' will receive ' + parseFloat(payment).toFixed(8) + ' and ' + parseFloat(mrt[address]).toFixed(2) + ' MRT and ' + parseFloat(merfees[address]).toFixed(8) + ' Mercury!');
        //send Waves fee
        if (Number(Math.round(payments[address])) > 0) {
            transactions.push({
                "amount": Number(Math.round(payments[address])),
               	"fee": 1, //bearwaves 0.01
                "feeAssetId": "9gnc5UCY6RxtSi9FEJkcD57r5NBgdr45DVYtunyDLrgC",
                "sender": config.address,
                "attachment": "DVCsMf2Av2pvvM8GNzzP1tQKZtd4jWfcHJQj9bky32RR6janfLK2",
                "recipient": address
            });
        }
        //send MRT
        if (Number(Math.round(mrt[address] * Math.pow(10, 2))) > 0) {
            transactions.push({
                "amount": Number(Math.round(mrt[address] * Math.pow(10, 2))),
               	"fee": 1, //bearwaves 0.01
                "feeAssetId": "9gnc5UCY6RxtSi9FEJkcD57r5NBgdr45DVYtunyDLrgC",
                "assetId": "4uK8i4ThRGbehENwa6MxyLtxAjAo1Rj9fduborGExarC",
                "sender": config.address,
                "attachment": "DVCsMf2Av2pvvM8GNzzP1tQKZtd4jWfcHJQj9bky32RR6janfLK2",
                "recipient": address
            });
        }
        //send mercury fee
        if (Number(Math.round(merfees[address])) > 0) {
            transactions.push({
                "amount": Number(Math.round(merfees[address])),
               	"fee": 1, //bearwaves 0.01
                "feeAssetId": "9gnc5UCY6RxtSi9FEJkcD57r5NBgdr45DVYtunyDLrgC",
                "assetId": "HzfaJp8YQWLvQG4FkUxq2Q7iYWMYQ2k8UF89vVJAjWPj",
                "sender": config.address,
                "attachment": "DVCsMf2Av2pvvM8GNzzP1tQKZtd4jWfcHJQj9bky32RR6janfLK2",
                "recipient": address
            });
        }   
        //this will send one BearWaves token to every leaser
            transactions.push({
                "amount": 100,
               	"fee": 1, //bearwaves 0.01
                "feeAssetId": "9gnc5UCY6RxtSi9FEJkcD57r5NBgdr45DVYtunyDLrgC",
                "assetId": "9gnc5UCY6RxtSi9FEJkcD57r5NBgdr45DVYtunyDLrgC",
                "sender": config.address,
                "attachment": "DVCsMf2Av2pvvM8GNzzP1tQKZtd4jWfcHJQj9bky32RR6janfLK2",
                "recipient": address
            });           
        
        totalMRT += mrt[address];
        totalfees += payments[address];
        totalmerfees += merfees[address];
        totalrbxfees += rbxfees[address];
        
        for (var i in allfees[address])
        {
        	
        	totalassetsfees[i] += allfees[address][i];
        }
        
        //html += "<tr><td>" + address + "</td><td>" + ((payments[address]/100000000).toPrecision(8) - 0.002) + "</td><td>" + (merfees[address]/100000000).toPrecision(8) + "</td><td>" + mrt[address].toPrecision(8) + "</td><td>" + (upfees[address]/100000000) + "</td></tr>\r\n";
        html += "<tr><td>" + address + "</td><td>" + 							 	//address column
				((payments[address]/100000000).toFixed(8)) + "</td><td>" + 	//Waves fee's
				mrt[address].toFixed(2) + "</td><td>" +                     //MRT
				(merfees[address]/100000000).toFixed(8) + "</td><td>" +		//Mercury fee's
				(rbxfees[address]/100000000).toFixed(8) + "</td></tr>" +		//Ripto Bux fee's 
				
				"\r\n";
    }
    
    html += "<tr><td><b>Total</b></td><td><b>" + ((totalfees/100000000).toFixed(8)) +
		 "</b></td><td><b>" + totalMRT.toFixed(2) + "</b></td><td><b>" +
		  (totalmerfees/100000000).toFixed(8) + "</b></td><td><b>" +
		  (totalrbxfees/100000000).toFixed(8) + "</b></td></tr>" +		  
			"\r\n";
    
    html += "</tbody>" +
"  </table>" +
"</div>" +

"</body>" +
"</html>";
    
    console.log("total fees: " + (totalfees/100000000) + " total MRT: " + totalMRT + " total Mer: " + (totalmerfees/100000000) + " total Up: " + (totalrbxfees/100000000) );
    console.log(totalassetsfees);
    var paymentfile = config.filename + config.paymentid + ".json";
    var htmlfile = config.filename + config.paymentid + ".html";
    
    fs.writeFile(paymentfile, JSON.stringify(transactions), {}, function(err) {
        if (!err) {
            console.log('payments written to ' + paymentfile + '!');
        } else {
            console.log(err);
        }
    });
    
    fs.writeFile(htmlfile, html, {}, function(err) {
        if (!err) {
            console.log('html written!');
        } else {
            console.log(err);
        }
    });    
    
    var latestblockinfo = {};
    latestblockinfo["leases"]=myLeases;
    latestblockinfo["canceledleases"]=myCanceledLeases;
    var blockleases = config.endBlock + "_" + config.address + ".json" ;
    
    fs.writeFile(blockleases, JSON.stringify(latestblockinfo), {}, function(err) {
        if (!err) {
            console.log('leaseinfo written to ' + blockleases + '!');
        } else {
            console.log(err);
        }
    });    
     
    var ActiveLeaseData = getActiveLeasesAtBlock(LastBlock);
		
    fs.writeFile("LastBlockLeasers.json", JSON.stringify(ActiveLeaseData), {}, function(err) {
        if (!err) {
            console.log('ActiveLeasers written to LastBlockLeasers.json!');
        } else {
            console.log(err);
        }
    });      
    
    
};

/**
 * This method returns (block-exact) the active leases and the total amount
 * of leased Waves for a given block.
 *
 * @param block the block to consider
 * @returns {{totalLeased: number, activeLeases: {}}} total amount of leased waves and active leases for the given block
 */
var getActiveLeasesAtBlock = function(block) {
    var activeLeases = [];
    var totalLeased = 0;
    var activeLeasesPerAddress = {};

    for (var leaseId in myLeases) {
        var currentLease = myLeases[leaseId];

        if (!myCanceledLeases[leaseId] || myCanceledLeases[leaseId].block > block.height) {
            activeLeases.push(currentLease);
        }
    }
    activeLeases.forEach(function (lease) {
        if (block.height > lease.block + 1000) {
            if (!activeLeasesPerAddress[lease.sender]) {
                activeLeasesPerAddress[lease.sender] = lease.amount;
            } else {
                activeLeasesPerAddress[lease.sender] += lease.amount;
            }

            totalLeased += lease.amount;
        }
    });

    return { totalLeased: totalLeased, activeLeases: activeLeasesPerAddress };
};


var InsertOrUpdateArray = function(MyArray,Key,Value)
{
			if(Key in MyArray)
			{
				MyArray[Key] += Value;
			} else
			{
				 MyArray[Key] = Value;
				
			}
			return MyArray;                       
};

start();

